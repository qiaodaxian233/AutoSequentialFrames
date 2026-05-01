# -*- coding: utf-8 -*-
"""
ComfyUI-AutoSequentialFrames
============================
自动顺序读取目录里的图片，输出相邻两张作为「首帧 / 尾帧」。
搭配前端 JS：执行成功后 current_index += step，并自动队列下一次，
从而实现 (img1,img2) → (img2,img3) → (img3,img4) ... 的连续视频链。
"""

import os
import re
import fnmatch
import torch
import numpy as np
from PIL import Image, ImageOps

try:
    from server import PromptServer
    from aiohttp import web
    _HAS_SERVER = True
except Exception:
    _HAS_SERVER = False


# ---------- 工具函数 ----------

def _natural_key(s: str):
    """自然排序：让 'img2.jpg' 排在 'img10.jpg' 前面。"""
    return [int(t) if t.isdigit() else t.lower() for t in re.split(r'(\d+)', s)]


def _scan_directory(directory: str,
                    pattern: str = "*.jpg;*.jpeg;*.png;*.webp;*.bmp",
                    sort_method: str = "natural"):
    """扫描目录，返回排序后的文件名列表（不含路径）。"""
    if not directory:
        return []
    directory = os.path.expanduser(directory)
    if not os.path.isdir(directory):
        return []

    patterns = [p.strip().lower() for p in pattern.split(";") if p.strip()]
    if not patterns:
        patterns = ["*.jpg", "*.png"]

    files = []
    try:
        for fname in os.listdir(directory):
            full = os.path.join(directory, fname)
            if not os.path.isfile(full):
                continue
            lower = fname.lower()
            for pat in patterns:
                if fnmatch.fnmatch(lower, pat):
                    files.append(fname)
                    break
    except OSError:
        return []

    if sort_method == "natural":
        files.sort(key=_natural_key)
    elif sort_method == "alphabetical":
        files.sort()
    elif sort_method == "modified_time":
        files.sort(key=lambda f: os.path.getmtime(os.path.join(directory, f)))
    else:
        files.sort(key=_natural_key)

    return files


def _load_image_tensor(path: str) -> torch.Tensor:
    """把磁盘图片加载成 ComfyUI 的 IMAGE 张量 [1, H, W, 3] (float32, 0~1)."""
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode != "RGB":
        img = img.convert("RGB")
    arr = np.array(img).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ]


# ---------- 主节点 ----------

class AutoSequentialImagePair:
    """
    🎬 自动顺序读取目录里的图片，输出相邻两张作为首/尾帧。

    生成完一次后:
      - 前端会把 current_index += step
      - 如果 auto_queue=True 且未到末尾，自动 queuePrompt
    从而实现连续视频链: (img[0],img[1]) → (img[1],img[2]) → ...

    用法 A (替换 LoadImage)：
      把本节点的 first_frame / last_frame 直接接到原本两个 LoadImage 输出去的位置。

    用法 B (信息输出)：
      first_filename / last_filename 输出当前用到的文件名，可接 ShowText 等节点查看。
    """

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": r"例如 D:\AI\frames  (绝对路径)",
                }),
                "pattern": ("STRING", {
                    "default": "*.jpg;*.jpeg;*.png;*.webp;*.bmp",
                    "multiline": False,
                }),
                "sort_method": (["natural", "alphabetical", "modified_time"],
                                {"default": "natural"}),
                "current_index": ("INT", {
                    "default": 0, "min": 0, "max": 99999, "step": 1,
                }),
                "step": ("INT", {
                    "default": 1, "min": 1, "max": 100, "step": 1,
                }),
                "loop_when_done": ("BOOLEAN", {
                    "default": False,
                    "label_on": "到末尾后回到开头",
                    "label_off": "到末尾自动停止",
                }),
                "auto_advance": ("BOOLEAN", {
                    "default": True,
                    "label_on": "执行后自动 +step",
                    "label_off": "保持 index 不变",
                }),
                "auto_queue": ("BOOLEAN", {
                    "default": True,
                    "label_on": "自动队列下一次",
                    "label_off": "只跑当前这次",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("IMAGE", "IMAGE", "STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("first_frame", "last_frame",
                    "first_filename", "last_filename",
                    "current_index", "total_count")
    FUNCTION = "load_pair"
    CATEGORY = "utils/AutoSequential"

    @classmethod
    def IS_CHANGED(cls, directory, pattern, sort_method,
                   current_index, step, **kwargs):
        # 只要 index/step/目录内容变化，就视为"已变更"，强制重新执行
        try:
            files = _scan_directory(directory, pattern, sort_method)
            sample = ",".join(files[:5])
            return f"{current_index}|{step}|{len(files)}|{sample}"
        except Exception:
            return f"{current_index}|{step}|err"

    def load_pair(self, directory, pattern, sort_method,
                  current_index, step,
                  loop_when_done, auto_advance, auto_queue,
                  unique_id=None):

        files = _scan_directory(directory, pattern, sort_method)
        if not files:
            raise RuntimeError(
                f"❌ 目录中找不到符合 pattern 的图片。\n"
                f"   directory = {directory}\n"
                f"   pattern   = {pattern}\n"
                f"   请检查路径是否正确（推荐用绝对路径）。"
            )

        total = len(files)
        if total < 2:
            raise RuntimeError(
                f"❌ 至少需要 2 张图片才能配成首尾帧，当前目录只有 {total} 张。"
            )

        if loop_when_done:
            idx1 = current_index % total
            idx2 = (current_index + step) % total
        else:
            max_first = total - step - 1
            if current_index > max_first:
                raise RuntimeError(
                    f"⚠️ 已遍历完所有图片：current_index={current_index}, "
                    f"total={total}, step={step}（最大允许 index = {max_first}）。\n"
                    f"   想继续可勾上 loop_when_done，或者把 current_index 重置为 0。"
                )
            idx1 = current_index
            idx2 = current_index + step

        base = os.path.expanduser(directory)
        first_path = os.path.join(base, files[idx1])
        last_path = os.path.join(base, files[idx2])

        first_img = _load_image_tensor(first_path)
        last_img = _load_image_tensor(last_path)

        print(
            f"[AutoSequential] pair {idx1+1}/{total}: "
            f"首帧={files[idx1]}  →  尾帧={files[idx2]}"
        )

        return (first_img, last_img,
                files[idx1], files[idx2],
                current_index, total)


# ---------- REST 接口（给前端 "扫描" 按钮用）----------

# ---------- 关键：解析"用户填的目录"到 ComfyUI/input/ ----------

def _resolve_directory(directory: str):
    """
    解析用户输入的 directory，返回 (实际扫描的绝对路径, 用作 LoadImage 前缀的相对路径)。

    支持三种写法：
      1) 'frames'                -> ComfyUI/input/frames/                  prefix='frames/'
      2) 'D:\\AI\\input\\frames' -> 绝对路径正好在 input 下                prefix='frames/'
      3) 'D:\\AI\\anywhere'      -> 绝对路径在 input 之外  prefix=''
         （这种 LoadImage 预览看不到图，需要先用 🔗 建立链接 把它链进 input/）
    """
    if not directory:
        return None, None

    raw = os.path.expanduser(directory).replace("\\", "/").rstrip("/")

    try:
        import folder_paths
        input_dir = os.path.abspath(folder_paths.get_input_directory())
    except Exception:
        input_dir = None

    # 情况 1：相对路径 → 拼到 input/ 下
    if not os.path.isabs(raw):
        if input_dir:
            candidate = os.path.join(input_dir, raw)
            if os.path.isdir(candidate):
                return candidate, raw.strip("/")
        return None, None

    # 情况 2/3：绝对路径
    abs_path = os.path.abspath(raw)
    if not os.path.isdir(abs_path):
        return None, None

    if input_dir:
        try:
            rel = os.path.relpath(abs_path, input_dir).replace("\\", "/")
            if not rel.startswith(".."):
                # 在 input 下 → LoadImage 能预览
                return abs_path, rel.strip("/")
        except ValueError:
            pass

    # 在 input 外：LoadImage 拿不到预览，但扫描能用
    return abs_path, ""


def _resolve_and_scan(directory, pattern, sort_method):
    abs_dir, _prefix = _resolve_directory(directory)
    if not abs_dir:
        return []
    return _scan_directory(abs_dir, pattern, sort_method)


# ---------- 节点 2：Controller (按 ID 遥控 LoadImage 节点) ----------

class AutoSequentialController:
    """
    🎯 遥控器节点：不替换 LoadImage，而是按节点 ID 更新它们的 image widget 值。
    跑完一次后自动 +step、自动重写 LoadImage、自动队列下一次。
    LoadImage 自带的图片预览保留，你能直观看到正在用哪两张图。
    """

    OUTPUT_NODE = True   # 让该节点在没接下游时也参与执行，方便我们 hook 到 execution_success

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "directory": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "input/ 下的子目录名（推荐），或绝对路径",
                }),
                "pattern": ("STRING", {
                    "default": "*.jpg;*.jpeg;*.png;*.webp;*.bmp",
                }),
                "sort_method": (["natural", "alphabetical", "modified_time"],
                                {"default": "natural"}),
                "first_node_id": ("STRING", {
                    "default": "",
                    "placeholder": "首帧 LoadImage 节点 ID, 如 97 或 129/97",
                }),
                "last_node_id": ("STRING", {
                    "default": "",
                    "placeholder": "尾帧 LoadImage 节点 ID, 如 184",
                }),
                "current_index": ("INT", {"default": 0, "min": 0, "max": 99999}),
                "step": ("INT", {"default": 1, "min": 1, "max": 100}),
                "loop_when_done": ("BOOLEAN", {
                    "default": False,
                    "label_on": "到末尾后回到开头",
                    "label_off": "到末尾自动停止",
                }),
                "auto_advance": ("BOOLEAN", {
                    "default": True,
                    "label_on": "执行后自动 +step",
                    "label_off": "保持 index 不变",
                }),
                "auto_queue": ("BOOLEAN", {
                    "default": True,
                    "label_on": "自动队列下一次",
                    "label_off": "只跑当前这次",
                }),
            },
            "hidden": {"unique_id": "UNIQUE_ID"},
        }

    RETURN_TYPES = ("STRING", "STRING", "INT", "INT")
    RETURN_NAMES = ("first_filename", "last_filename", "current_index", "total_count")
    FUNCTION = "execute"
    CATEGORY = "utils/AutoSequential"

    @classmethod
    def IS_CHANGED(cls, directory, pattern, sort_method, current_index, step,
                   first_node_id, last_node_id, **kwargs):
        try:
            files = _resolve_and_scan(directory, pattern, sort_method)
            return f"{current_index}|{step}|{first_node_id}|{last_node_id}|{len(files)}"
        except Exception:
            return f"{current_index}|{step}|err"

    def execute(self, directory, pattern, sort_method,
                first_node_id, last_node_id,
                current_index, step, loop_when_done,
                auto_advance, auto_queue, unique_id=None):

        files = _resolve_and_scan(directory, pattern, sort_method)
        if not files:
            raise RuntimeError(
                f"❌ 找不到图片：directory={directory}\n"
                f"   推荐把图片放在 ComfyUI/input/<子目录>/ 下，directory 填子目录名即可。"
            )

        total = len(files)
        if total < 2:
            raise RuntimeError(f"❌ 至少需要 2 张图片，当前只有 {total} 张")

        if loop_when_done:
            idx1 = current_index % total
            idx2 = (current_index + step) % total
        else:
            max_first = total - step - 1
            if current_index > max_first:
                raise RuntimeError(
                    f"⚠️ 已遍历完图片：current_index={current_index}, "
                    f"max={max_first}, total={total}, step={step}。\n"
                    f"   可勾选 loop_when_done 循环，或重置 current_index。"
                )
            idx1 = current_index
            idx2 = current_index + step

        f1, f2 = files[idx1], files[idx2]
        print(f"[AutoSeq Controller] pair {idx1+1}/{total}: {f1} → {f2}  "
              f"(targets: first=#{first_node_id}, last=#{last_node_id})")

        return (f1, f2, current_index, total)


# ---------- REST 接口 ----------

def _is_under(child: str, parent: str) -> bool:
    """child 是不是 parent 的子目录（或同一个目录）。不抛异常的简单字符串前缀比较。"""
    if not child or not parent:
        return False
    try:
        c = os.path.abspath(child).replace("\\", "/").rstrip("/")
        p = os.path.abspath(parent).replace("\\", "/").rstrip("/")
        if os.name == "nt":
            c, p = c.lower(), p.lower()
        return c == p or c.startswith(p + "/")
    except Exception:
        return False


def _empty_scan_response(directory="", error=None):
    return {
        "directory": directory or "",
        "resolved": "",
        "input_dir": "",
        "prefix": "",
        "in_input_dir": False,
        "exists": False,
        "count": 0,
        "files": [],
        "preview": [],
        "error": error or "",
    }


if _HAS_SERVER:
    @PromptServer.instance.routes.post("/auto_sequential/scan")
    async def _scan_endpoint(request):
        # 整个端点用 try/except 兜底：无论发生什么都返回合法 JSON，避免前端 res.json() 解析炸掉
        directory = ""
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}
            directory = (data.get("directory") or "") if isinstance(data.get("directory"), str) else ""
            pattern = (data.get("pattern") or "*.jpg;*.jpeg;*.png;*.webp;*.bmp")
            sort_method = (data.get("sort_method") or "natural")

            abs_dir, prefix = _resolve_directory(directory)
            files = _scan_directory(abs_dir, pattern, sort_method) if abs_dir else []

            try:
                import folder_paths
                input_dir = os.path.abspath(folder_paths.get_input_directory())
            except Exception:
                input_dir = ""

            in_input_dir = _is_under(abs_dir, input_dir) if abs_dir else False
            exists = bool(abs_dir) and os.path.isdir(abs_dir)

            return web.json_response({
                "directory": directory,
                "resolved": abs_dir or "",
                "input_dir": input_dir,
                "prefix": prefix if prefix is not None else "",
                "in_input_dir": bool(in_input_dir),
                "exists": bool(exists),
                "count": int(len(files)),
                "files": list(files),
                "preview": list(files[:50]),
                "error": "",
            })
        except Exception as e:
            import traceback
            tb = traceback.format_exc()
            print(f"[AutoSequential] /scan 端点出错: {e}\n{tb}")
            # 注意：仍然返回 200 + 合法 JSON，让前端能把 error 显示到状态行
            return web.json_response(
                _empty_scan_response(directory=directory, error=f"{type(e).__name__}: {e}"),
                status=200,
            )

    @PromptServer.instance.routes.post("/auto_sequential/link")
    async def _link_endpoint(request):
        """在 ComfyUI/input/ 下建立指向用户图片目录的软链接 / Windows 目录联接。"""
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}
            src = (data.get("src") or "").strip()
            if not src:
                return web.json_response({"ok": False, "error": "src 为空"})

            src = os.path.expanduser(src)
            if not os.path.isdir(src):
                return web.json_response({"ok": False, "error": f"源目录不存在: {src}"})

            try:
                import folder_paths
                input_dir = folder_paths.get_input_directory()
            except Exception as e:
                return web.json_response({"ok": False, "error": f"无法获取 input 目录: {e}"})

            # 自动决定链接名
            link_name = (data.get("name") or "").strip()
            if not link_name:
                base = os.path.basename(os.path.normpath(src))
                link_name = base if base else "auto_seq_linked"

            # 防止非法字符
            link_name = re.sub(r'[\\/:*?"<>|]', "_", link_name)
            dst = os.path.join(input_dir, link_name)

            # 已存在
            if os.path.lexists(dst):
                try:
                    if os.path.islink(dst) or (os.name == "nt" and os.path.isdir(dst)):
                        return web.json_response({
                            "ok": True, "name": link_name, "existed": True,
                            "msg": f"input/{link_name} 已存在，直接复用",
                        })
                except Exception:
                    pass
                return web.json_response({
                    "ok": False,
                    "error": f"input/{link_name} 已存在且不是链接，请换个 name 或先删掉",
                })

            try:
                if os.name == "nt":
                    # Windows: 目录联接 (junction)，无需管理员权限
                    import subprocess
                    r = subprocess.run(
                        ["cmd", "/c", "mklink", "/J", dst, src],
                        capture_output=True, text=True, shell=False,
                    )
                    if r.returncode != 0:
                        return web.json_response({
                            "ok": False,
                            "error": (r.stderr or r.stdout or "mklink 失败").strip(),
                        })
                else:
                    os.symlink(src, dst)
                return web.json_response({
                    "ok": True, "name": link_name, "existed": False,
                    "msg": f"已创建 input/{link_name} → {src}",
                })
            except Exception as e:
                return web.json_response({"ok": False, "error": f"创建链接失败: {e}"})

        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response(
                {"ok": False, "error": f"{type(e).__name__}: {e}"},
                status=200,
            )

    @PromptServer.instance.routes.post("/auto_sequential/inject")
    async def _inject_endpoint(request):
        """
        【核心】把 src 文件的内容**覆盖**到 ComfyUI/input/<dst> 上，
        相当于"用同一个文件名重新上传一张图"。
        LoadImage 节点的 widget 值丝毫不变 —— 但 LoadImage 内置的
        IS_CHANGED 是基于文件 SHA256 的，文件内容一变它就会自动重新加载。
        """
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}

            src = (data.get("src") or "").strip()
            dst = (data.get("dst") or "").strip()
            if not src or not dst:
                return web.json_response({"ok": False, "error": "src 或 dst 为空"})

            src = os.path.expanduser(src)
            if not os.path.isfile(src):
                return web.json_response({"ok": False, "error": f"源文件不存在: {src}"})

            try:
                import folder_paths
                input_dir = os.path.abspath(folder_paths.get_input_directory())
            except Exception as e:
                return web.json_response({"ok": False, "error": f"获取 input 目录失败: {e}"})

            # dst 可能形如 "00115-1.jpg" 或 "subfolder/file.jpg"
            # 把 Windows 风格的 \ 统一成 /
            dst_clean = dst.replace("\\", "/").lstrip("/")
            dst_full = os.path.abspath(os.path.join(input_dir, dst_clean))

            # 安全：dst 必须在 input_dir 下，不能用 ../ 跳出去
            if not _is_under(dst_full, input_dir):
                return web.json_response({
                    "ok": False,
                    "error": f"dst 必须在 input/ 下: {dst} → {dst_full}",
                })

            # 同一个文件就别复制了
            if os.path.abspath(src) == dst_full:
                return web.json_response({
                    "ok": True, "src": src, "dst": dst,
                    "msg": "源 = 目标，跳过", "skipped": True,
                })

            # 确保目标父目录存在
            os.makedirs(os.path.dirname(dst_full), exist_ok=True)

            import shutil
            shutil.copyfile(src, dst_full)

            return web.json_response({
                "ok": True,
                "src": src,
                "dst": dst,
                "dst_full": dst_full,
                "size": os.path.getsize(dst_full),
            })

        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response(
                {"ok": False, "error": f"{type(e).__name__}: {e}"},
                status=200,
            )

NODE_CLASS_MAPPINGS = {
    "AutoSequentialImagePair": AutoSequentialImagePair,
    "AutoSequentialController": AutoSequentialController,
}

NODE_DISPLAY_NAME_MAPPINGS = {
    "AutoSequentialImagePair": "🎬 Auto Sequential Image Pair (首尾帧自动队列)",
    "AutoSequentialController": "🎯 Auto Sequential Controller (按 ID 遥控 LoadImage)",
}
