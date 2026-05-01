# -*- coding: utf-8 -*-
"""
ComfyUI-AutoSequentialFrames
============================
自动顺序读取目录里的图片，输出相邻两张作为「首帧 / 尾帧」。
搭配前端 JS：执行成功后 current_index += step，并自动队列下一次，
从而实现 (img1,img2) → (img2,img3) → (img3,img4) ... 的连续视频链。

v4 新增「尾帧模式」(tail_frame_mode)：
    生成完一段视频后，自动从 ComfyUI/output/ 里找最新的、分辨率匹配的视频
    （默认 1920x1088，用来过滤掉中间预览/低分辨率版本），抽出它的最后一帧
    作为下一段视频的「首帧」。这样一段段视频接力时画面真正连续，不会因为
    模型生成的尾帧和目录里的目标关键帧之间存在差异而出现跳变。
    「尾帧」目标仍然按目录顺序往后取，目录起到「目标关键帧」的作用。
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


# ---------- 视频工具函数 (尾帧模式用) ----------

VIDEO_EXTENSIONS = (".mp4", ".webm", ".mov", ".mkv", ".avi", ".m4v")


def _parse_resolution(s: str):
    """把 '1920x1088' / '1920*1088' / '1920×1088' 解析为 (1920, 1088)。失败返回 (0,0)。"""
    if not s:
        return (0, 0)
    txt = s.lower().replace("*", "x").replace("×", "x").replace(" ", "")
    parts = txt.split("x")
    if len(parts) != 2:
        return (0, 0)
    try:
        return int(parts[0]), int(parts[1])
    except ValueError:
        return (0, 0)


def _scan_videos(output_dir: str, since_mtime: float = 0.0):
    """
    扫描 output_dir（递归）下所有视频文件，返回 [(path, mtime), ...]，
    只保留 mtime >= since_mtime 的，按 mtime 从新到旧排好序。
    """
    if not output_dir or not os.path.isdir(output_dir):
        return []

    items = []
    try:
        for root, _dirs, files in os.walk(output_dir):
            for fname in files:
                if not fname.lower().endswith(VIDEO_EXTENSIONS):
                    continue
                full = os.path.join(root, fname)
                try:
                    m = os.path.getmtime(full)
                except OSError:
                    continue
                if m + 1e-3 < since_mtime:  # 容忍一点 mtime 精度差
                    continue
                items.append((full, m))
    except OSError:
        return []

    items.sort(key=lambda x: x[1], reverse=True)
    return items


def _get_video_resolution(video_path: str):
    """返回视频的 (width, height)。打不开就返 (0, 0)。"""
    try:
        import cv2
    except ImportError:
        return (0, 0)
    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        return (0, 0)
    try:
        w = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        h = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
        return (w, h)
    finally:
        cap.release()


def _extract_video_last_frame(video_path: str, dst_path: str):
    """
    把视频的最后一帧写成图片文件 (dst_path 推荐用 .jpg/.png)。
    返回 (width, height)。
    """
    try:
        import cv2
    except ImportError:
        raise RuntimeError(
            "尾帧模式需要 opencv-python。请在 ComfyUI 环境里执行: "
            "pip install opencv-python"
        )

    cap = cv2.VideoCapture(video_path)
    if not cap.isOpened():
        raise RuntimeError(f"无法打开视频: {video_path}")

    last_frame = None
    width = height = 0
    try:
        total = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
        width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
        height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

        # 先尝试 seek 到最后几帧（更快）。某些编码 seek 不准，所以试多次。
        if total > 0:
            for offset in range(min(8, total)):
                target = total - 1 - offset
                cap.set(cv2.CAP_PROP_POS_FRAMES, max(0, target))
                ret, frame = cap.read()
                if ret and frame is not None:
                    last_frame = frame
                    # 继续往后读，能读到比当前更晚的帧就更新
                    while True:
                        ret2, fr2 = cap.read()
                        if not ret2 or fr2 is None:
                            break
                        last_frame = fr2
                    break

        # 兜底：从头线性读到尾
        if last_frame is None:
            cap.release()
            cap = cv2.VideoCapture(video_path)
            while True:
                ret, frame = cap.read()
                if not ret or frame is None:
                    break
                last_frame = frame

        if last_frame is None:
            raise RuntimeError(f"无法从视频读取任何帧: {video_path}")

        # 确保目标目录存在
        dst_dir = os.path.dirname(dst_path)
        if dst_dir:
            os.makedirs(dst_dir, exist_ok=True)

        # cv2.imwrite 期望 BGR，cv2.VideoCapture 读出来就是 BGR，直接写即可
        # 注意：cv2.imwrite 在路径含中文/特殊字符时可能失败，用 imencode + 文件写入兜底
        try:
            ok = cv2.imwrite(dst_path, last_frame)
        except Exception:
            ok = False
        if not ok:
            ext = os.path.splitext(dst_path)[1].lower() or ".jpg"
            success, buf = cv2.imencode(ext, last_frame)
            if not success:
                raise RuntimeError(f"cv2.imencode 失败: {dst_path}")
            with open(dst_path, "wb") as f:
                f.write(buf.tobytes())

        return width, height
    finally:
        try:
            cap.release()
        except Exception:
            pass


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
                "tail_frame_mode": ("BOOLEAN", {
                    "default": False,
                    "label_on": "尾帧模式: 用上一段视频最后一帧作首帧",
                    "label_off": "正常模式: 从目录顺序取首帧",
                }),
                "output_dir": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "placeholder": "输出视频目录 (留空 = ComfyUI/output/)",
                }),
                "target_resolution": ("STRING", {
                    "default": "1920x1088",
                    "multiline": False,
                    "placeholder": "目标分辨率, 如 1920x1088 (用于过滤掉中间预览视频)",
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
            tail = "T" if kwargs.get("tail_frame_mode") else "D"
            return f"{current_index}|{step}|{first_node_id}|{last_node_id}|{len(files)}|{tail}"
        except Exception:
            return f"{current_index}|{step}|err"

    def execute(self, directory, pattern, sort_method,
                first_node_id, last_node_id,
                current_index, step, loop_when_done,
                auto_advance, auto_queue,
                tail_frame_mode=False, output_dir="", target_resolution="1920x1088",
                unique_id=None):

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
        mode_label = "尾帧链" if tail_frame_mode else "目录链"
        print(f"[AutoSeq Controller/{mode_label}] pair {idx1+1}/{total}: {f1} → {f2}  "
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

    @PromptServer.instance.routes.post("/auto_sequential/extract_tail_frame")
    async def _extract_tail_frame_endpoint(request):
        """
        【尾帧模式核心】扫描 output 目录里最新的、分辨率匹配的视频，
        把它的最后一帧提取出来，直接覆盖写入 input/<dst_filename>，
        让目标 LoadImage 自动重新加载（基于文件 SHA256 的 IS_CHANGED）。

        请求体:
        {
          "output_dir":      "..." (留空则用 ComfyUI 默认 output 目录),
          "target_width":    1920,
          "target_height":   1088,
          "since_timestamp": 1700000000.0  (留 0 表示不过滤 mtime),
          "dst_filename":    "00115-1.jpg" (input/ 下的目标文件名)
        }

        响应:
        {
          "ok": true/false,
          "video_path": "...",
          "video_mtime": 1700000123.4,
          "video_resolution": "1920x1088",
          "dst_full": "...",
          "dst_filename": "...",
          "candidates": [...]  (前 5 个候选，方便调试),
          "error": ""
        }
        """
        try:
            try:
                data = await request.json()
            except Exception:
                data = {}
            if not isinstance(data, dict):
                data = {}

            output_dir = (data.get("output_dir") or "").strip()
            try:
                target_w = int(data.get("target_width") or 1920)
                target_h = int(data.get("target_height") or 1088)
            except (TypeError, ValueError):
                target_w, target_h = 1920, 1088
            try:
                since_ts = float(data.get("since_timestamp") or 0)
            except (TypeError, ValueError):
                since_ts = 0.0
            dst_filename = (data.get("dst_filename") or "").strip()

            if not dst_filename:
                return web.json_response({"ok": False, "error": "dst_filename 为空"})

            # 默认用 ComfyUI 的 output 目录
            if not output_dir:
                try:
                    import folder_paths
                    output_dir = folder_paths.get_output_directory()
                except Exception as e:
                    return web.json_response(
                        {"ok": False, "error": f"无法获取 output 目录: {e}"})

            output_dir = os.path.expanduser(output_dir)
            if not os.path.isdir(output_dir):
                return web.json_response(
                    {"ok": False, "error": f"output 目录不存在: {output_dir}"})

            # 扫描 since_ts 之后写入的所有视频（已按 mtime 从新到旧排序）
            videos = _scan_videos(output_dir, since_mtime=since_ts)
            if not videos:
                return web.json_response({
                    "ok": False,
                    "error": (
                        f"在 {output_dir} 里没找到 since_timestamp={since_ts} 之后的"
                        f"视频文件 (扩展名: {','.join(VIDEO_EXTENSIONS)})"
                    ),
                })

            # 在候选里找第一个分辨率匹配的（最新的）
            candidates = []
            matched = None
            for path, mtime in videos[:20]:  # 最多看 20 个，避免目录里视频太多时太慢
                w, h = _get_video_resolution(path)
                candidates.append({
                    "path": path,
                    "mtime": mtime,
                    "resolution": f"{w}x{h}",
                })
                if matched is None and w == target_w and h == target_h:
                    matched = (path, mtime, w, h)

            if not matched:
                return web.json_response({
                    "ok": False,
                    "error": (
                        f"没在最近的视频里找到 {target_w}x{target_h} 分辨率的。"
                        f"前 5 个候选: " +
                        ", ".join(
                            f"{os.path.basename(c['path'])}({c['resolution']})"
                            for c in candidates[:5]
                        )
                    ),
                    "candidates": candidates[:10],
                })

            video_path, video_mtime, vw, vh = matched

            # 解析 dst 到 input/ 下
            try:
                import folder_paths
                input_dir = os.path.abspath(folder_paths.get_input_directory())
            except Exception as e:
                return web.json_response(
                    {"ok": False, "error": f"无法获取 input 目录: {e}"})

            dst_clean = dst_filename.replace("\\", "/").lstrip("/")
            dst_full = os.path.abspath(os.path.join(input_dir, dst_clean))

            if not _is_under(dst_full, input_dir):
                return web.json_response({
                    "ok": False,
                    "error": f"dst_filename 必须在 input/ 下: {dst_filename} → {dst_full}",
                })

            # 提取最后一帧并写入到 input/<dst_filename>
            try:
                _extract_video_last_frame(video_path, dst_full)
            except Exception as e:
                import traceback
                traceback.print_exc()
                return web.json_response(
                    {"ok": False, "error": f"提取最后一帧失败: {e}"})

            print(
                f"[AutoSeq] 尾帧抽取: {os.path.basename(video_path)} "
                f"({vw}x{vh}, mtime={video_mtime:.1f}) "
                f"→ input/{dst_clean}"
            )

            return web.json_response({
                "ok": True,
                "video_path": video_path,
                "video_mtime": video_mtime,
                "video_resolution": f"{vw}x{vh}",
                "dst_full": dst_full,
                "dst_filename": dst_filename,
                "candidates": candidates[:5],
                "error": "",
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
