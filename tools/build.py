"""从校验过的公开发行包生成 MGU Store 软件源。"""

import argparse
import gzip
import hashlib
import io
import json
import re
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"\d+\.\d+\.\d+")
LEGAL = ROOT / "licenses"


def read_json(path):
    return json.loads(path.read_bytes())


def encode(value):
    return (json.dumps(value, ensure_ascii=False, indent=2) + "\n").encode()


def digest(data):
    return hashlib.sha256(data).hexdigest()


def write(path, data):
    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(dir=path.parent, delete=False) as tmp:
        tmp.write(data)
    Path(tmp.name).chmod(0o644)
    Path(tmp.name).replace(path)


def acquire(artifact, cache):
    path = cache / artifact["name"]
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cache) as tmp:
            subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                            "--retry", "3", "--output", tmp.name, artifact["url"]], check=True)
            data = Path(tmp.name).read_bytes()
            check_bytes(data, artifact)
            write(path, data)
    data = path.read_bytes()
    check_bytes(data, artifact)
    return data


def check_bytes(data, artifact):
    if len(data) != artifact["size"] or digest(data) != artifact["sha256"]:
        raise ValueError(f"安装包大小或 SHA-256 不符：{artifact['name']}")


def unpack(data):
    files = {}
    with tarfile.open(fileobj=io.BytesIO(data), mode="r:gz") as archive:
        for member in archive:
            path = PurePosixPath(member.name)
            if path.is_absolute() or ".." in path.parts:
                raise ValueError(f"无效路径 {path}")
            if member.isdir():
                continue
            if not member.isfile() or path.as_posix() in files:
                raise ValueError(f"无效安装包成员 {path}")
            files[path.as_posix()] = (archive.extractfile(member).read(), member.mode & 0o777)
    return files


def pack(files):
    output = io.BytesIO()
    with gzip.GzipFile(fileobj=output, mode="wb", filename="", mtime=0, compresslevel=9) as zipped:
        with tarfile.open(fileobj=zipped, mode="w", format=tarfile.GNU_FORMAT) as archive:
            for name, (data, mode) in sorted(files.items()):
                item = tarfile.TarInfo(name)
                item.size, item.mode = len(data), mode
                archive.addfile(item, io.BytesIO(data))
    return output.getvalue()


def update_json(files, path, change):
    data, mode = files[path]
    obj = json.loads(data)
    change(obj)
    files[path] = (encode(obj), mode)


def remove_promotion_rows(files, path):
    obj = json.loads(files[path][0])
    removed = set()
    for state in obj.get("containers", {}).values():
        components = state.get("components", {})
        for key, component in list(components.items()):
            if component.get("name") in ("CN_CREDITS", "translationCredit"):
                removed.add(key)
                del components[key]
    if not removed:
        return
    xml_path = path.rsplit("/", 1)[0] + "/application.xml"
    xml = ET.fromstring(files[xml_path][0])
    found = set()
    for parent in xml.iter():
        for child in list(parent):
            if child.tag == "component" and child.get("id") in removed:
                found.add(child.get("id"))
                parent.remove(child)
    if found != removed:
        raise ValueError(f"RHMI 描述与布局中的控件编号不一致：{path}")
    files[path] = (encode(obj), files[path][1])
    files[xml_path] = (ET.tostring(xml, encoding="utf-8", xml_declaration=True), files[xml_path][1])


def clean_script(name, data, app_id):
    text = data.decode("utf-8")
    promotion = re.compile(r"小白(?:151|科技杂物社)|JackieZ123430|抖音", re.I)
    lines = []
    for line in text.splitlines(keepends=True):
        stripped = line.lstrip()
        if promotion.search(line):
            if stripped.startswith("//") and not re.search(r"copyright|SPDX", line, re.I):
                continue
            if name.endswith("/credits.js") and stripped.startswith("const CREDIT ="):
                line = "const CREDIT = '';\n"
            elif name.endswith("/credits.js"):
                line = line.replace("'汉化 · 小白151'", "CREDIT")
            elif name == "src/i18n.js":
                line = re.sub(r'CREDIT: "Translation by:[^"]*"', 'CREDIT: ""', line)
            elif app_id == "ram_mic_calibration" and name.endswith("/view.js") and stripped.startswith("cv.text("):
                continue
            elif app_id == "dk_backgammon" and stripped.startswith("const CREDIT ="):
                continue
        if app_id == "dk_backgammon" and name == "src/app.js":
            if "'SID_NARDY_CREDIT',CREDIT" in line:
                continue
            line = line.replace("setRowCount(rows.length + 1)", "setRowCount(rows.length)")
        lines.append(line)
    return "".join(lines).encode()


def translate_settings(files, prefix, translations):
    kit = prefix + "javascript/kit/"
    locale = json.loads(files[kit + "locale.json"][0])
    dictionary = json.loads(files[kit + "locales/zh-CN.json"][0])
    tsv_path = kit + "locales/zh-CN.tsv"
    rows = files[tsv_path][0].decode().splitlines()
    spec = json.loads(files[kit + "app-spec.json"][0])
    settings = {opt["key"]: opt for opt in spec["settings"]}
    bundles = {name: json.loads(data) for name, (data, _) in files.items()
               if "/texts/" in name and name.endswith(".json")}
    chinese = bundles[prefix + "rhmiData/variantGroups/Common/texts/zh_CN.json"]
    fonts = json.loads(files[kit + "fonts/cjk.json"][0])["sizes"]
    for sid, edit in translations.items():
        english, label = edit["source"], edit["text"]
        old = locale["strings"][english]
        setting = settings[edit["setting"]]
        if old != chinese[sid] or old != dictionary[english] or old != setting["label"]:
            raise ValueError(f"{sid} 的上游译文发生变化，请核对后重建")
        for size in fonts:
            if any(str(ord(ch)) not in size["glyphs"] for ch in label if ord(ch) > 127):
                raise ValueError(f"{sid} 的字库缺少译文中的字形")
        setting["label"] = dictionary[english] = locale["strings"][english] = label
        index = rows.index(english + "\t" + old)
        rows[index] = english + "\t" + label
        for bundle in bundles.values():
            if bundle.get(sid) == old:
                bundle[sid] = label
    for name, obj in {**bundles, kit + "locale.json": locale, kit + "locales/zh-CN.json": dictionary,
                      kit + "app-spec.json": spec}.items():
        files[name] = (encode(obj), files[name][1])
    files[tsv_path] = (("\n".join(rows) + "\n").encode(), files[tsv_path][1])


def rebuild(app, cache):
    files = unpack(acquire(app["base"], cache))
    old_name = app["base"]["name"][:-4]
    new_name = app["id"] + "@" + app["version"]
    if "mgu-app.json" in files:
        old_tree = json.loads(files["mgu-app.json"][0])["tree"]
        if old_tree != old_name:
            raise ValueError(f"源码包目录不符：{old_tree}")
        files = {(new_name + n[len(old_tree):] if n.startswith(old_tree + "/") else n): v
                 for n, v in files.items()}
        update_json(files, "mgu-app.json", lambda d: d.update(version=app["version"], tree=new_name))
    prefix = next(n[:-len("rhmiData/application.json")] for n in files if n.endswith("rhmiData/application.json"))
    rhmi_path = prefix + "rhmiData/application.json"
    rhmi = json.loads(files[rhmi_path][0])["application"]
    pkg = json.loads(files[prefix + "package.json"][0])
    if pkg["name"] != app["id"] or old_name != pkg["name"] + "@" + pkg["version"]:
        raise ValueError(f"应用标识或版本不符：{old_name}")
    if rhmi["version"] != pkg["version"]:
        raise ValueError(f"RHMI 版本不符：{old_name}")
    update_json(files, rhmi_path, lambda d: d["application"].update(version=app["version"]))
    for name, (data, mode) in list(files.items()):
        if name.endswith("/uiDescription.json"):
            remove_promotion_rows(files, name)
        elif "/texts/" in name and name.endswith(".json"):
            strings = json.loads(data)
            kept = {k: v for k, v in strings.items() if "_CN_CREDITS_" not in k}
            if kept != strings:
                files[name] = (encode(kept), mode)
        elif name.endswith("/kit/locale.json"):
            obj = json.loads(data)
            obj.pop("credit", None)
            obj.pop("credits", None)
            files[name] = (encode(obj), mode)
        elif name.endswith(".js"):
            files[name] = (clean_script(name, data, app["id"]), mode)
        elif name in (prefix + "package.json", prefix + "npm-shrinkwrap.json", prefix + "javascript/kit/app-spec.json"):
            obj = json.loads(data)
            obj["version"] = app["version"]
            if name == prefix + "package.json":
                obj["description"] = app["description"]
            files[name] = (encode(obj), mode)
    # 发行说明记录当前版本；原始包及其校验值可从来源记录取回。
    for name in ("SOURCE.zh-CN.json", "FONT-COVERAGE.zh-CN.json"):
        files.pop(name, None)
    source = {k: app[k] for k in ("id", "version", "project", "source", "base")}
    if app.get("additionalSources"):
        source["additionalSources"] = app["additionalSources"]
    source["changes"] = "2026-11-24：更新中文应用说明，移除界面中的翻译推广文字。"
    translation_file = Path("translations") / (app["id"] + ".json")
    if (ROOT / translation_file).is_file():
        translate_settings(files, prefix, read_json(ROOT / translation_file))
        source["translations"] = translation_file.as_posix()
        source["changes"] += " 修订设置项的中文译文。"
    files[prefix + "SOURCE.json"] = (encode(source), 0o644)
    notices = {app["notice"]}
    if "translationNotice" in app:
        notices.add(app["translationNotice"])
    if any("/kit/" in name for name in files):
        notices.update(("OFL-Barlow.txt", "cauliflowermossgrape--idrive7-apps.txt"))
    for filename in notices:
        files[prefix + "licenses/" + filename] = ((LEGAL / filename).read_bytes(), 0o644)
    icon_name = rhmi["entryPoints"][0].get("icon")
    icon = next((b for n, (b, _) in files.items() if "/images/" in n and n.endswith("/" + (icon_name or ""))), None)
    if icon and len(icon) <= 128 * 1024:
        write(ROOT / "icons" / (app["id"] + ".png"), icon)
    write(ROOT / "packages" / (new_name + ".tgz"), pack(files))


def catalog_entry(app):
    entry = {k: app[k] for k in ("id", "title", "description", "author", "version", "build",
                                 "mguHmi", "requires", "uninstallable") if k in app}
    entry["kind"] = "app"
    if app.get("external"):
        entry["artifact"] = app["base"]
    else:
        name = app["id"] + "@" + app["version"] + ".tgz"
        data = (ROOT / "packages" / name).read_bytes()
        entry["artifact"] = dict(name=name, url="packages/" + name, size=len(data), sha256=digest(data))
    icon = Path("icons") / (app["id"] + ".png")
    if (ROOT / icon).exists():
        data = (ROOT / icon).read_bytes()
        if not data.startswith(b"\x89PNG\r\n\x1a\n") or len(data) > 128 * 1024:
            raise ValueError(f"无效图标 {icon}")
        entry.update(icon=icon.as_posix(), iconSha256=digest(data))
    return entry


def validate(entries):
    versions = {}
    for entry in entries:
        key, version, a = entry["id"], entry["version"], entry["artifact"]
        if key in versions or not VERSION.fullmatch(version) or a["name"] != f"{key}@{version}.tgz":
            raise ValueError(f"组件标识或版本有误 {key}")
        if not re.fullmatch(r"[a-f0-9]{64}", a["sha256"]) or a["size"] <= 0:
            raise ValueError(f"缺少有效校验值 {key}")
        versions[key] = tuple(map(int, version.split(".")))
    for entry in entries:
        for key, minimum in entry.get("requires", {}).items():
            if key not in versions or versions[key] < tuple(map(int, minimum.split("."))):
                raise ValueError(f"{entry['id']} 依赖 {key} >= {minimum}")


def verify_package(app, entry):
    archive = ROOT / entry["artifact"]["url"]
    files = unpack(archive.read_bytes())
    if any("/node_modules/oap-sdk/" in "/" + n for n in files):
        raise ValueError(f"{archive.name} 含有车机 SDK")
    prefix = next(n[:-len("rhmiData/application.json")] for n in files if n.endswith("rhmiData/application.json"))
    pkg = json.loads(files[prefix + "package.json"][0])
    rhmi = json.loads(files[prefix + "rhmiData/application.json"][0])["application"]
    if pkg["name"] != app["id"] or {pkg["version"], rhmi["version"]} != {entry["version"]}:
        raise ValueError(f"{archive.name} 的应用标识或内部版本与目录不符")
    if app.get("build") == "unit":
        manifest = json.loads(files["mgu-app.json"][0])
        if manifest["tree"] + "/" != prefix or manifest["version"] != pkg["version"]:
            raise ValueError(f"{archive.name} 的源码包清单与应用目录不符")
        for name in manifest["modules"]:
            if name not in files:
                raise ValueError(f"{archive.name} 缺少模块 {name}")
    for path, (data, _) in files.items():
        if path.endswith("uiDescription.json"):
            ui = json.loads(data)
            for container in ui.get("containers", {}).values():
                if any(c.get("name") in ("CN_CREDITS", "translationCredit")
                       for c in container.get("components", {}).values()):
                    raise ValueError(f"{archive.name} 的 {path} 包含推广控件")
        elif path.endswith("kit/locale.json"):
            locale = json.loads(data)
            if locale.get("credit") or locale.get("credits", {}).get("zh-CN"):
                raise ValueError(f"{archive.name} 的中文界面包含水印")
    if prefix + "licenses/" + app["notice"] not in files:
        raise ValueError(f"{archive.name} 缺少许可证")


def directory(apps):
    lines = ["# 应用目录", "", "软件源中的版本见下表。名称链接指向原项目，源码链接指向本版使用的源码或翻译修订。", ""]
    for group in ("驾驶", "诊断", "座舱", "出行", "娱乐", "系统"):
        lines += ["## " + group, "", "| 应用 | 功能 | 版本 | 来源 |", "| --- | --- | --- | --- |"]
        for app in apps:
            if app["category"] == group:
                lines.append(f"| [{app['title']}]({app['project']}) | {app['description']} | "
                             f"`{app['version']}` | [源码]({app['source']}) |")
        lines.append("")
    return "\n".join(lines).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("rebuild", "index", "check"))
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    args = parser.parse_args()
    apps = read_json(ROOT / "data/apps.json")
    if args.action == "rebuild":
        for app in apps:
            if not app.get("external"):
                rebuild(app, args.cache)
    entries = [catalog_entry(app) for app in apps] + read_json(ROOT / "data/tools.json")
    validate(entries)
    if args.action == "check":
        for app, entry in zip(apps, entries):
            if not app.get("external"):
                verify_package(app, entry)
    products = {"catalog.json": encode({"schema": 2, "components": entries}), "APPS.md": directory(apps)}
    for name, data in products.items():
        if args.action == "check":
            if data != (ROOT / name).read_bytes():
                raise SystemExit(f"{name} 与当前清单或安装包不一致")
        else:
            write(ROOT / name, data)
    print(f"{len(apps)} 款应用，{len(entries) - len(apps)} 个运行组件")


if __name__ == "__main__":
    main()
