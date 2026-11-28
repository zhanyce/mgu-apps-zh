"""检查 MGU Store 源码源、运行组件和已登记的迁移例外。"""

from pathlib import PurePosixPath
from urllib.parse import urlsplit

from build import ROOT, VERSION, read_json, require_build_url, validate


def repo_path(name, root=ROOT):
    path = PurePosixPath(name)
    if path.is_absolute() or path.as_posix() != name or ".." in path.parts or "\\" in name:
        raise ValueError(f"无效的源码路径 {name}")
    resolved = root / path
    if not resolved.exists():
        raise FileNotFoundError(resolved)
    return resolved


def check_app(entry, folder):
    app_id = entry["id"]
    build = entry["build"]
    if build == "unit":
        spec = read_json(folder / "mgu-app.json")
        tree = repo_path(spec["tree"], folder)
        package = read_json(tree / "package.json")
        rhmi = read_json(tree / "rhmiData/application.json")["application"]
        if (app_id, spec["version"]) != (package["name"], package["version"]):
            raise ValueError(f"{app_id} 的 mgu-app.json 与 package.json 不符")
        if (app_id, spec["version"]) != (rhmi["name"], rhmi["version"]):
            raise ValueError(f"{app_id} 的 mgu-app.json 与车机清单不符")
        for path in spec["modules"]:
            if repo_path(path, folder).suffix != ".js":
                raise ValueError(f"{app_id} 的模块需要 JavaScript 文件")
        return spec
    if not build.get("shared") or not repo_path(build["python"]).is_file():
        raise ValueError(f"{app_id} 的构建脚本缺失")
    for name in build["shared"]:
        repo_path(name)
    spec = read_json(repo_path(entry["manifest"], folder))
    if entry["manifest"] == "app.json":
        output = build["output"].format(id=app_id, version=spec["version"], dir=entry["path"])
        output_path = PurePosixPath(output)
        if "{id}" not in build["args"] or output_path.name != f"{app_id}@{spec['version']}.tgz":
            raise ValueError(f"{app_id} 的构建输出与应用版本不符")
        repo_path(output_path.parent.parent.as_posix())
        if "sdk" in build:
            sdk = PurePosixPath(build["sdk"])
            if sdk.name != "oap-sdk" or (repo_path(sdk.parent.as_posix()) / sdk.name).exists():
                raise ValueError(f"{app_id} 的车机 SDK 路径无效")
        return spec
    if build["args"] != ["{dir}", "{id}", "{version}"]:
        raise ValueError(f"{app_id} 的构建参数无效")
    if build["sdk"] != spec["kit"] + "/oap-sdk" or (ROOT / build["sdk"]).exists():
        raise ValueError(f"{app_id} 的车机 SDK 路径无效")
    if spec["upstreamVersion"] != read_json(folder / "app.json")["version"]:
        raise ValueError(f"{app_id} 的原项目版本与构建配置不符")
    if "browserBuilder" in spec:
        repo_path(spec["browserBuilder"])
    else:
        repo_path(spec["kit"] + "/kit/tools/build.py")
    if "widgetBuilder" in spec:
        repo_path(spec["widgetBuilder"])
    return spec


def runtime_catalog(path):
    runtime = read_json(repo_path(path))
    if runtime["schema"] != 2:
        raise ValueError(f"{path} 的软件源格式版本不符")
    archives = runtime["components"]
    if any(e["kind"] != "tool" or urlsplit(e["artifact"]["url"]).scheme != "https" for e in archives):
        raise ValueError("运行组件源需要使用 HTTPS 的 tool 条目")
    if len({e["id"] for e in archives}) != len(archives):
        raise ValueError(f"{path} 包含重复的运行组件")
    return {e["id"]: e for e in archives}


def main():
    doc = read_json(ROOT / "mgu-repo.json")
    if doc["schema"] != 1:
        raise ValueError("源码源格式版本不符")
    runtime = runtime_catalog("runtime/catalog.json")
    validate(list(runtime.values()))
    versions = {app_id: entry["version"] for app_id, entry in runtime.items()}
    source_apps = set()
    for entry in doc["components"]:
        app_id = entry["id"]
        folder = repo_path(entry["path"])
        if entry["kind"] == "app":
            spec = check_app(entry, folder)
            source_apps.add(app_id)
        elif entry["kind"] == "tool":
            spec = read_json(folder / "component.json")
            for group in ("files", "units"):
                for row in spec.get(group, []):
                    repo_path(row.get("from") or row.get("path") or row["name"], folder)
        else:
            raise ValueError(f"{app_id} 的组件类型无效")
        if app_id in versions or spec["id"] != app_id or not VERSION.fullmatch(spec["version"]):
            raise ValueError(f"{app_id} 的源码清单标识或版本无效")
        versions[app_id] = spec["version"]
        for src in [folder, *folder.parents]:
            if (src / "SOURCE.json").is_file():
                pin = read_json(src / "SOURCE.json")
                require_build_url("https://github.com/" + pin["repo"])
                break
        else:
            raise ValueError(f"{app_id} 缺少原项目提交记录")
        entry["requires"] = {**spec.get("requires", {}), **entry.get("requires", {})}
    runtime_overrides = {}
    for entry in doc["components"]:
        available = versions
        path = entry.get("runtimeCatalog")
        if path:
            if path not in runtime_overrides:
                overrides = runtime_catalog(path)
                validate(list({**runtime, **overrides}.values()))
                runtime_overrides[path] = {key: tool["version"] for key, tool in overrides.items()}
            available = {**versions, **runtime_overrides[path]}
        for dep, needed in entry["requires"].items():
            if dep not in available or version_tuple(available[dep]) < version_tuple(needed):
                raise ValueError(f"{entry['id']} 需要 {dep} >= {needed}")
    app_data = read_json(ROOT / "data/apps.json")
    apps = {app["id"] for app in app_data}
    exceptions = read_json(ROOT / "data/source-exceptions.json")
    if source_apps & exceptions.keys() or source_apps | exceptions.keys() != apps:
        raise ValueError("源码源与登记的应用范围不符")
    if any(app.get("sourceOnly") and app["id"] not in source_apps for app in app_data):
        raise ValueError("仅从源码发布的应用缺少构建清单")
    for file in (ROOT / "sources/projects").rglob("*"):
        parts = file.relative_to(ROOT).parts
        if file.is_symlink() or {"oap-sdk", "node_modules"} & set(parts) or file.suffix in (".tgz", ".mgu"):
            raise ValueError(f"源码目录包含不应发布的文件 {file.relative_to(ROOT)}")
    print(f"{len(source_apps)} 款源码应用，{len(versions) - len(source_apps)} 个运行组件，"
          f"{len(exceptions)} 款仅有历史安装包")


def version_tuple(text):
    if not VERSION.fullmatch(text):
        raise ValueError(f"版本号无效 {text}")
    return tuple(map(int, text.split(".")))


if __name__ == "__main__":
    main()
