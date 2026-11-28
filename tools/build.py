"""从原项目源码构建已迁移的组件，并维护 MGU Store 软件源。"""

import argparse
import gzip
import hashlib
import io
import json
import os
import re
import subprocess
import tarfile
import tempfile
import xml.etree.ElementTree as ET
from pathlib import Path, PurePosixPath
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
VERSION = re.compile(r"\d+\.\d+\.\d+")
LEGAL = ROOT / "licenses"
TOOL_PACKER = {
    "repo": "robertnisipeanu/mgu-store",
    "commit": "554d8072096a860d5c20d19c71062220bc40a2a5",
    "size": 7828919,
    "sha256": "f17da98cbe0f0717b3a66ed904bef093024596bfb22d2549c651cd9f7275249a",
}
REFERENCE_OWNER = "jackiez123430"


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
    require_build_url(artifact["url"])
    path = cache / artifact["name"]
    if not path.exists():
        cache.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=cache) as tmp:
            subprocess.run(["curl", "--fail", "--location", "--silent", "--show-error",
                            "--connect-timeout", "10", "--max-time", "120", "--retry", "3",
                            "--output", tmp.name, artifact["url"]], check=True)
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


def require_build_url(url):
    parsed = urlsplit(url)
    parts = unquote(parsed.path).casefold().split("/")
    if parsed.hostname and (REFERENCE_OWNER in parts or parsed.hostname.split(".")[0] == REFERENCE_OWNER):
        raise ValueError(f"小白仓库仅供参考，不可作为构建或下载来源：{url}")


def source_files(pin, cache):
    repo, commit = pin["repo"], pin["commit"]
    if not re.fullmatch(r"[a-zA-Z0-9][a-zA-Z0-9-]*/[a-zA-Z0-9][a-zA-Z0-9_.-]*", repo) or not re.fullmatch(
        r"[a-f0-9]{40}", commit
    ):
        raise ValueError("源码必须固定到 GitHub 项目和完整提交号")
    artifact = {
        "name": f"{repo.replace('/', '--')}-{commit}.tar.gz",
        "url": f"https://codeload.github.com/{repo}/tar.gz/{commit}",
        "size": pin["size"],
        "sha256": pin["sha256"],
    }
    prefix = f"{repo.split('/')[1]}-{commit}/"
    files = unpack(acquire(artifact, cache))
    if not files or any(not name.startswith(prefix) for name in files):
        raise ValueError(f"源码归档目录不符：{repo}@{commit}")
    return {name[len(prefix):]: item for name, item in files.items()}


def source_subdir(files, directory):
    prefix = PurePosixPath(directory).as_posix() + "/"
    selected = {name[len(prefix):]: item for name, item in files.items() if name.startswith(prefix)}
    if not selected:
        raise ValueError(f"源码归档中没有目录 {directory}")
    return selected


def stage_files(files, root):
    for name, (content, mode) in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_bytes(content)
        path.chmod(mode)


def unit_files(app, cache):
    recipe = app["sourceBuild"]
    if recipe["format"] != "unit" or app.get("build") != "unit":
        raise ValueError(f"{app['id']} 需要已验证的源码构建方式")
    if app["project"].casefold() != f"https://github.com/{recipe['repo']}".casefold():
        raise ValueError(f"源码构建必须使用应用的原项目：{app['id']}")
    source = source_files(recipe, cache)
    files = source_subdir(source, recipe["path"])
    patch = ROOT / "translations/source" / (app["id"] + ".patch")
    if patch.is_file():
        with tempfile.TemporaryDirectory() as tmp:
            stage = Path(tmp)
            stage_files(files, stage)
            subprocess.run(["git", "apply", str(patch)], cwd=stage,
                           env={**os.environ, "GIT_CONFIG_COUNT": "0"}, check=True)
            files = {path.relative_to(stage).as_posix(): (path.read_bytes(), path.stat().st_mode & 0o777)
                     for path in stage.rglob("*") if path.is_file()}
    manifest = json.loads(files["mgu-app.json"][0])
    tree = manifest["tree"]
    if (manifest["id"], manifest["version"]) != (app["id"], app["upstreamVersion"]):
        raise ValueError(f"上游源码包标识或版本不符：{app['id']}")
    if not tree or PurePosixPath(tree).is_absolute() or ".." in PurePosixPath(tree).parts:
        raise ValueError(f"上游源码包目录无效：{tree}")
    modules = set(manifest["modules"])
    if modules - files.keys():
        raise ValueError(f"上游源码包缺少模块：{app['id']}")
    files = {name: item for name, item in files.items()
             if name == "mgu-app.json" or name in modules or name.startswith(tree + "/")}
    if any("oap-sdk" in PurePosixPath(name).parts for name in files):
        raise ValueError(f"源码发布包含有车机 SDK：{app['id']}")
    for name, content in source.items():
        if "/" not in name and re.match(r"^(LICENSE|NOTICE|COPYING)", name, re.I):
            files.setdefault(tree + "/" + name, content)
    return files


def translate_unit(files, prefix, recipe):
    text = recipe["text"]
    dynamic = {}
    for stem, count in recipe.get("dynamic", {}).items():
        if not isinstance(count, int) or not 1 <= count <= 256:
            raise ValueError(f"无效的车机字符串数量：{stem}")
        dynamic.update({stem if count == 1 else f"{stem}{index}": "" for index in range(count)})
    locale = json.loads(files[prefix + "rhmiData/application.json"][0])["application"]["defaultLanguage"]
    prefix = prefix + "rhmiData/variantGroups/Common/texts/"
    bundles = [name for name in files if name.startswith(prefix) and name.endswith(".json")]
    for name in bundles:
        table, mode = files[name]
        strings = json.loads(table)
        if text.keys() - strings.keys() or dynamic.keys() & strings.keys():
            raise ValueError(f"上游字符串 ID 已变化：{name}")
        files[name] = (encode({**strings, **text, **dynamic}), mode)
    files.setdefault(prefix + "zh_CN.json", files[prefix + locale + ".json"])


def rebuild_tool(tool, cache):
    recipe = tool["sourceBuild"]
    files = source_subdir(source_files(recipe, cache), recipe["path"])
    manifest = json.loads(files["component.json"][0])
    if manifest.get("build") or (manifest["id"], manifest["version"]) != (tool["id"], tool["version"]):
        raise ValueError(f"组件须使用与清单一致的原项目发布文件：{tool['id']}")
    for group in ("files", "units", "dropins"):
        for entry in manifest.get(group, []):
            name = entry.get("from", entry.get("path", entry.get("name")))
            if name not in files:
                raise ValueError(f"组件缺少上游文件：{name}")
    packer = source_files(TOOL_PACKER, cache)
    artifact = tool["artifact"]
    if artifact["url"] != f"packages/components/{artifact['name']}":
        raise ValueError(f"组件发布路径无效：{tool['id']}")
    with tempfile.TemporaryDirectory() as tmp:
        work = Path(tmp)
        stage_files({name: packer[name] for name in ("deploy/hu", "tools/oap_pack.js")}, work)
        stage_files(files, work / "input")
        subprocess.run(["node", str(work / "deploy/hu"), "artifact", str(work / "input"),
                        "--out", str(work / "output")], cwd=work,
                       env={**os.environ, "SOURCE_DATE_EPOCH": "1792281600"}, check=True)
        content = (work / "output" / artifact["name"]).read_bytes()
        check_bytes(content, artifact)
        write(ROOT / artifact["url"], content)


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
        matching = [i for i, row in enumerate(rows) if row.startswith(english + "\t")]
        if len(matching) != 1 or rows[matching[0]].split("\t", 1)[1] not in (old, label):
            raise ValueError(f"{sid} 的 TSV 译文发生变化，请核对后重建")
        rows[matching[0]] = english + "\t" + label
        for bundle in bundles.values():
            if bundle.get(sid) == old:
                bundle[sid] = label
    for name, obj in {**bundles, kit + "locale.json": locale, kit + "locales/zh-CN.json": dictionary,
                      kit + "app-spec.json": spec}.items():
        files[name] = (encode(obj), files[name][1])
    files[tsv_path] = (("\n".join(rows) + "\n").encode(), files[tsv_path][1])


def translate_menus(files, prefix, app_id, patch=False):
    kit = prefix + "javascript/kit/"
    locale = json.loads(files[kit + "locale.json"][0])
    if patch and locale.get("language") != "zh-CN":
        raise ValueError(f"{app_id} 的菜单局部修订需要简体中文输入包")
    overrides = read_json(ROOT / "translations/menus" / (app_id + ".json"))
    words = dict(locale["strings"])
    dictionary = kit + "locales/zh-CN.json"
    if dictionary in files and not patch:
        words.update(json.loads(files[dictionary][0]))
    words.update(overrides)
    locale.update(language="zh-CN", strings=words)
    files[kit + "locale.json"] = (encode(locale), 0o644)
    if dictionary in files:
        entries = json.loads(files[dictionary][0]) if patch else words
        entries.update(overrides)
        files[dictionary] = (encode(entries), files[dictionary][1])
        tsv = kit + "locales/zh-CN.tsv"
        if tsv in files:
            if patch:
                pending = dict(overrides)
                lines = files[tsv][0].decode().splitlines()
                for i, row in enumerate(lines):
                    key, sep, _ = row.partition("\t")
                    if sep and key in overrides:
                        lines[i] = key + "\t" + overrides[key]
                        pending.pop(key, None)
                lines.extend(f"{key}\t{value}" for key, value in pending.items())
                rows = "\n".join(lines) + "\n"
            else:
                rows = "".join(f"{key}\t{value}\n" for key, value in words.items())
            files[tsv] = (rows.encode(), files[tsv][1])

    font_path = ROOT / "translations/fonts" / (app_id + ".json")
    font = kit + "fonts/cjk.json"
    if font_path.is_file():
        files[font] = (font_path.read_bytes(), files[font][1])
    for size in json.loads(files[font][0])["sizes"]:
        for label in overrides.values():
            if any(str(ord(c)) not in size["glyphs"] for c in label if ord(c) > 127):
                raise ValueError(f"{app_id} 的字库缺少译文字形：{label}")

    labels = overrides if patch else words

    def tr(text):
        return labels.get(text, text)

    def update_spec(spec):
        spec["title"] = tr(spec["title"])
        for item in spec.get("settings", []):
            item["label"] = tr(item["label"])
            for option in item.get("options", []):
                option[1] = tr(option[1])
        for screen in spec["screens"]:
            if "title" in screen:
                screen["title"] = tr(screen["title"])
            for button in screen.get("buttons", []):
                button[1] = tr(button[1])
            for row in screen.get("items", []):
                if len(row) > 2 and isinstance(row[2], str):
                    row[2] = tr(row[2])
                if row[0] == "dropdown" and len(row) > 3 and isinstance(row[3], list):
                    row[3] = [tr(label) for label in row[3]]

    update_json(files, kit + "app-spec.json", update_spec)
    for name, (data, mode) in list(files.items()):
        if "/texts/" in name and name.endswith(".json"):
            bundle = json.loads(data)
            files[name] = (encode({sid: tr(value) for sid, value in bundle.items()}), mode)


def rebuild(app, cache):
    files = unit_files(app, cache)
    upstream_version = app["upstreamVersion"]
    new_name = app["id"] + "@" + app["version"]
    if "mgu-app.json" in files:
        old_tree = json.loads(files["mgu-app.json"][0])["tree"]
        files = {(new_name + n[len(old_tree):] if n.startswith(old_tree + "/") else n): v
                 for n, v in files.items()}
        update_json(files, "mgu-app.json", lambda d: d.update(version=app["version"], tree=new_name))
    prefix = next(n[:-len("rhmiData/application.json")] for n in files if n.endswith("rhmiData/application.json"))
    rhmi_path = prefix + "rhmiData/application.json"
    rhmi = json.loads(files[rhmi_path][0])["application"]
    pkg = json.loads(files[prefix + "package.json"][0])
    if (pkg["name"], pkg["version"]) != (app["id"], upstream_version):
        raise ValueError(f"应用标识或版本不符：{app['id']}@{upstream_version}")
    if rhmi["version"] != pkg["version"]:
        raise ValueError(f"RHMI 版本不符：{app['id']}@{upstream_version}")
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
    # 发布包附原项目提交、归档校验值及本仓库的翻译文件。
    for name in ("SOURCE.zh-CN.json", "FONT-COVERAGE.zh-CN.json"):
        files.pop(name, None)
    source = {k: app[k] for k in ("id", "version", "upstreamVersion", "project", "source", "sourceBuild")}
    if app.get("additionalSources"):
        source["additionalSources"] = app["additionalSources"]
    source["changes"] = "从原项目源码构建并维护简体中文界面。"
    unit_translation = Path("translations/source") / (app["id"] + ".json")
    if (ROOT / unit_translation).is_file():
        translate_unit(files, prefix, read_json(ROOT / unit_translation))
        source["translations"] = unit_translation.as_posix()
        if (ROOT / unit_translation.with_suffix(".patch")).is_file():
            source["translationPatch"] = unit_translation.with_suffix(".patch").as_posix()
    translation_file = Path("translations") / (app["id"] + ".json")
    if (ROOT / translation_file).is_file():
        translate_settings(files, prefix, read_json(ROOT / translation_file))
        source["translations"] = translation_file.as_posix()
        if app.get("settingsRevision"):
            source["changes"] += f" {app['settingsRevision']}：修订设置项的中文译文。"
        else:
            source["changes"] += " 修订设置项的中文译文。"
    if "menuRevision" in app:
        translate_menus(files, prefix, app["id"], patch=app.get("menuMode") == "patch")
        if "translations" in source:
            source["settingsTranslations"] = source["translations"]
        source["translations"] = f"translations/menus/{app['id']}.json"
        source["changes"] = f"{app['menuRevision']}：更新车机菜单、设置项和运行时的简体中文译文。"
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
        require_build_url(a["url"])
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
        if (manifest["id"], manifest["tree"] + "/", manifest["version"]) != (app["id"], prefix, pkg["version"]):
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
    if "sourceBuild" in app:
        source = json.loads(files[prefix + "SOURCE.json"][0])
        if any(source[key] != app[key] for key in ("sourceBuild", "source", "upstreamVersion")):
            raise ValueError(f"{archive.name} 的源码来源与清单不符")


def directory(apps):
    entries = read_json(ROOT / "mgu-repo.json")["components"]
    source = {entry["id"]: entry for entry in entries if entry["kind"] == "app"}
    lines = ["# 应用目录", "", "应用名称指向原项目。版本列显示源码源中的版本。", ""]
    for group in ("驾驶", "诊断", "座舱", "出行", "娱乐", "系统"):
        lines += ["## " + group, "", "| 应用 | 功能 | 版本 | 发布方式 |", "| --- | --- | --- | --- |"]
        for app in apps:
            if app["category"] != group:
                continue
            entry = source.get(app["id"])
            if entry:
                manifest = entry.get("manifest", "mgu-app.json")
                version = read_json(ROOT / entry["path"] / manifest)["version"]
                delivery = f"[车机从源码构建]({entry['path']}/)"
            else:
                version = app["version"]
                delivery = "[历史安装包](data/source-exceptions.json)"
            lines.append(f"| [{app['title']}]({app['project']}) | {app['description']} | "
                         f"`{version}` | {delivery} |")
        lines.append("")
    return "\n".join(lines).encode()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("rebuild", "index", "check"))
    parser.add_argument("--cache", type=Path, default=ROOT / ".cache")
    parser.add_argument("--only", metavar="ID", action="append", help="仅重建指定的源码应用或组件，可重复指定")
    args = parser.parse_args()
    apps = read_json(ROOT / "data/apps.json")
    tools = read_json(ROOT / "data/tools.json")
    if args.only and args.action != "rebuild":
        parser.error("--only 仅适用于 rebuild")
    if args.action == "rebuild":
        candidates = {app["id"]: (app, rebuild) for app in apps if "sourceBuild" in app}
        candidates.update({tool["id"]: (tool, rebuild_tool) for tool in tools if "sourceBuild" in tool})
        selected = args.only or list(candidates)
        for key in selected:
            if key not in candidates:
                parser.error(f"{key} 尚未配置源码构建")
        for key in selected:
            entry, action = candidates[key]
            action(entry, args.cache)
    legacy_apps = [app for app in apps if not app.get("sourceOnly")]
    entries = [catalog_entry(app) for app in legacy_apps] + [
        {k: v for k, v in tool.items() if k != "sourceBuild"} for tool in tools
    ]
    validate(entries)
    if args.action == "check":
        for app, entry in zip(legacy_apps, entries):
            if not app.get("external"):
                verify_package(app, entry)
        for tool in tools:
            if "sourceBuild" in tool:
                artifact = tool["artifact"]
                check_bytes((ROOT / artifact["url"]).read_bytes(), artifact)
    products = {"catalog.json": encode({"schema": 2, "components": entries}), "APPS.md": directory(apps)}
    for name, data in products.items():
        if args.action == "check":
            if data != (ROOT / name).read_bytes():
                raise SystemExit(f"{name} 与当前清单或安装包不一致")
        else:
            write(ROOT / name, data)
    print(f"{len(apps)} 款应用，历史目录含 {len(legacy_apps)} 款应用和 {len(tools)} 个运行组件")


if __name__ == "__main__":
    main()
