"""MGU Store 在车机上调用上游构建脚本，生成所选的中文应用。"""

import argparse
import json
import os
import re
import runpy
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from build import clean_script, encode, pack, read_json, remove_promotion_rows, unpack, update_json


def localize_kit(kit, source, edits):
    runtime = kit / "kit/runtime"
    locales = runtime / "locales"
    locales.mkdir(exist_ok=True)
    zh = locales / "zh-CN.json"
    shared = read_json(source / "zh-CN.json")
    words = {**shared, **(read_json(zh) if zh.exists() else {}), **edits}
    zh.write_bytes(encode(words))
    rows = "".join(f"{english}\t{label}\n" for english, label in words.items()
                   if not any(c in english or c in label for c in "\n\r\t"))
    (locales / "zh-CN.tsv").write_text(rows, encoding="utf-8")
    fonts = runtime / "fonts"
    fonts.mkdir(exist_ok=True)
    for name in ("cjk.json", "OFL-NotoSansSC.txt"):
        if not (fonts / name).is_file():
            shutil.copyfile(source / name, fonts / name)
    credit = kit / "kit/localization/credit.zh-CN.json"
    credit.parent.mkdir(exist_ok=True)
    credit.write_bytes(encode(dict(settingsTitle="", settingsLink="", corner="", comment=[])))


def build_kit(recipe, store_dir, app_id, preview, output=None):
    root = Path(recipe["kit"])
    path = root / "apps" / app_id
    if path.resolve() != store_dir.resolve():
        path.parent.mkdir(parents=True, exist_ok=True)
        shutil.copytree(store_dir, path, dirs_exist_ok=True)
    spec_file = path / "app.json"
    spec = read_json(spec_file)
    if spec["version"] != recipe["upstreamVersion"]:
        raise ValueError(f"{app_id} 的上游版本与清单不符")
    spec["id"] = app_id
    spec_file.write_bytes(encode(spec))
    localize_kit(root, Path("sources/zh"), recipe.get("translations", {}))
    command = [sys.executable, "kit/tools/build.py", "--language", "zh-CN"]
    if preview:
        command.append("--preview-only")
    command.append(app_id)
    env = os.environ.copy()
    if output is not None:
        output.mkdir()
        env["MGU_OUT"] = str(output)
    subprocess.run(command, cwd=root, env=env, check=True)
    if preview:
        return None
    matching = [archive for directory in (root / "dist", output)
                for archive in directory.glob(f"{app_id}@*.tgz")]
    if len(matching) != 1:
        raise ValueError(f"{app_id} 的上游构建未生成唯一安装包")
    stage = root / "dist" / app_id
    widgets = {}
    if "widgetBuilder" in recipe:
        path = runpy.run_path(recipe["widgetBuilder"])["package_widget"](stage)
        widgets = {
            item.relative_to(path.parent).as_posix(): (item.read_bytes(), 0o644)
            for item in path.rglob("*") if item.is_file()
        }
    return matching[0], widgets


def build_browser(recipe, store_dir, app_id, temporary):
    root = Path(recipe["kit"]).resolve()
    output = temporary / "browser"
    upstream = recipe["upstreamVersion"]
    command = [sys.executable, str(Path(recipe["browserBuilder"]).resolve()),
               "--app", app_id, "--version", upstream,
               "--source", str(store_dir.resolve().relative_to(root))]
    subprocess.run(command, cwd=root, env={**os.environ, "MGU_OUT": str(output)}, check=True)
    return output / f"{app_id}@{upstream}.tgz", {}


def finalize(archive, widgets, recipe, app_id, version):
    files = unpack(archive.read_bytes())
    prefix = next(path[:-len("rhmiData/application.json")]
                  for path in files if path.endswith("/rhmiData/application.json") or path == "rhmiData/application.json")
    files.update({prefix + name: data for name, data in widgets.items()})
    legal = Path(recipe["kit"])
    for name in ("LICENSE", "NOTICE", "NOTICE.zh-CN.md", "THIRD_PARTY_LICENSES", "THIRD_PARTY_NOTICES.md"):
        if (legal / name).is_file():
            files.setdefault(prefix + "licenses/" + name, ((legal / name).read_bytes(), 0o644))
    files.setdefault(prefix + "licenses/NOTICE.shared.zh-CN.md",
                     (Path("sources/zh/NOTICE.zh-CN.md").read_bytes(), 0o644))
    package = read_version(files[prefix + "package.json"][0], app_id, recipe["upstreamVersion"])
    rhmi = json.loads(files[prefix + "rhmiData/application.json"][0])
    if rhmi["application"]["name"] != app_id or rhmi["application"]["version"] != package["version"]:
        raise ValueError(f"{app_id} 的车机清单与生成包不符")
    package.update(version=version, description=recipe["description"])
    if "startType" in recipe:
        package["mguAppStartType"] = recipe["startType"]
    files[prefix + "package.json"] = (encode(package), 0o644)
    for name, (raw, mode) in list(files.items()):
        if name in (prefix + "rhmiData/application.json", prefix + "rhmiDataStartWidget/application.json"):
            update_json(files, name, lambda d: d["application"].update(version=version))
        elif name.endswith("/uiDescription.json"):
            remove_promotion_rows(files, name)
        elif "/texts/" in name and name.endswith(".json"):
            original = json.loads(raw)
            strings = {k: v for k, v in original.items() if "_CN_CREDITS_" not in k}
            if strings != original:
                files[name] = (encode(strings), mode)
        elif name.endswith("/kit/locale.json"):
            locale = json.loads(raw)
            for key in ("credit", "credits"):
                locale.pop(key, None)
            files[name] = (encode(locale), mode)
        elif name.startswith(prefix + "javascript/") and name.endswith(".js"):
            files[name] = (clean_script(name, raw, app_id), mode)
        elif name in (prefix + "npm-shrinkwrap.json", prefix + "javascript/kit/app-spec.json"):
            update_json(files, name, lambda d: d.update(version=version))
    return pack(files)


def read_version(raw, app_id, upstream):
    package = json.loads(raw)
    versions = re.escape(upstream) + r"(?:-zh\.cn\.\d+)?"
    if package["name"] != app_id or not re.fullmatch(versions, package["version"], re.I):
        raise ValueError(f"{app_id} 的上游安装包标识或版本不符")
    return package


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", type=Path)
    parser.add_argument("id")
    parser.add_argument("version")
    parser.add_argument("--preview", action="store_true")
    args = parser.parse_args()
    recipe = read_json(args.directory / "store-source.json")
    if (recipe["id"], recipe["version"]) != (args.id, args.version):
        parser.error("应用 ID 或版本与 MGU Store 的来源清单不符")
    if args.preview:
        if recipe.get("browserBuilder"):
            parser.error("浏览器预览需使用原项目的运行组件")
        build_kit(recipe, args.directory, args.id, True)
        return
    output = Path(os.environ["MGU_OUT"])
    with tempfile.TemporaryDirectory(prefix="mgu-app-build-") as tmp:
        if recipe.get("browserBuilder"):
            archive, widgets = build_browser(recipe, args.directory, args.id, Path(tmp))
        else:
            archive, widgets = build_kit(recipe, args.directory, args.id, False, Path(tmp) / "kit")
        (output / f"{args.id}@{args.version}.tgz").write_bytes(
            finalize(archive, widgets, recipe, args.id, args.version))


if __name__ == "__main__":
    main()
