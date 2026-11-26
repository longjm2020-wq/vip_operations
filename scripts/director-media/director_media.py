"""Local AI Director media providers. All process arguments originate in this adapter or the operator's config."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tempfile


KINDS = {"voice_clone", "talking_head", "ae_template", "lottie", "pag"}
MOTION = Path(__file__).with_name("motion.cjs")
DEFAULT_CONFIG = Path(os.getenv("LOCALAPPDATA", str(Path.home()))) / "XutiDesktop" / "director-media.json"


def read_json(path):
    with open(path, encoding="utf-8-sig") as stream:
        return json.load(stream)


def file(value):
    if isinstance(value, str) and Path(value).is_absolute() and Path(value).is_file():
        return Path(value).resolve()
    return None


def directory(value):
    if isinstance(value, str) and Path(value).is_absolute() and Path(value).is_dir():
        return Path(value).resolve()
    return None


def run(args, cwd=None, timeout=3600):
    process = subprocess.run([str(arg) for arg in args], cwd=cwd, timeout=timeout,
                             stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                             creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0), check=False)
    if process.returncode:
        raise ValueError("媒体引擎执行失败：" + process.stdout[-1100:].decode("utf-8", errors="replace").strip())
    return process.stdout.decode("utf-8", errors="replace")


def read_config():
    configured = os.environ.get("XUTI_DIRECTOR_MEDIA_CONFIG")
    path = Path(configured) if configured else DEFAULT_CONFIG
    if not path.is_absolute():
        raise ValueError("媒体引擎配置需要绝对路径")
    config = read_json(path) if path.is_file() else {}
    config.setdefault("templates", {}).setdefault("product-title", {
        "kind": "lottie", "path": str(Path(__file__).with_name("lower-third.json").resolve()),
        "textLayers": {"title": "Title"},
    })
    return config


def qwen_python(cfg):
    configured = cfg.get("qwenPython")
    return file(configured) if configured else Path(sys.executable).resolve()


def qwen_modules_ready(interpreter):
    modules = ("qwen_tts", "torch", "torchaudio", "soundfile")
    if not interpreter:
        return False
    if interpreter == Path(sys.executable).resolve():
        return all(importlib.util.find_spec(module) for module in modules)
    probe = "import importlib.util,sys;sys.exit(0 if all(importlib.util.find_spec(m) for m in sys.argv[1:]) else 1)"
    try:
        run([interpreter, "-c", probe, *modules], timeout=15)
        return True
    except (OSError, ValueError, subprocess.SubprocessError):
        return False


def capabilities(cfg):
    result = dict.fromkeys(KINDS, False)
    result["templates"] = []
    model = directory(cfg.get("qwenModel"))
    result["voice_clone"] = bool(model and all((model / path).is_file() for path in (
        "model.safetensors", "config.json", "speech_tokenizer/model.safetensors"))
        and qwen_modules_ready(qwen_python(cfg)))
    muse = directory(cfg.get("museRoot"))
    muse_python = file(cfg.get("musePython"))
    if muse and muse_python and file(cfg.get("ffmpeg")) and all((muse / path).exists() for path in (
            "scripts/inference.py", "models/musetalkV15/unet.pth", "models/musetalkV15/musetalk.json",
            "models/sd-vae", "models/whisper", "models/dwpose", "models/face-parse-bisent")):
        try:
            result["talking_head"] = run([muse_python, "-c", "import torch,diffusers,transformers,cv2; print(torch.cuda.is_available())"], timeout=30).strip().endswith("True")
        except (OSError, ValueError, subprocess.SubprocessError):
            pass
    motion = directory(cfg.get("motionModules"))
    node = file(cfg.get("node"))
    for key, tmpl in cfg.get("templates", {}).items():
        if not re.fullmatch(r"[A-Za-z0-9_-]{1,80}", key) or not isinstance(tmpl, dict):
            continue
        kind, src = tmpl.get("kind"), file(tmpl.get("path"))
        if not src:
            continue
        ready = False
        if kind in ("lottie", "pag"):
            lib = "lottie-web/build/player/lottie_light.min.js" if kind == "lottie" else "libpag/lib/libpag.umd.js"
            ready = (src.suffix.lower() == (".json" if kind == "lottie" else ".pag") and node and motion and
                     (motion / "playwright-core/package.json").is_file() and (motion / lib).is_file() and
                     (kind != "pag" or (motion / "libpag/lib/libpag.wasm").is_file()) and
                     file(cfg.get("chromium")) and file(cfg.get("ffmpeg")) and MOTION.is_file())
        elif kind == "ae_template":
            ready = src.suffix.lower() == ".aep" and file(cfg.get("aerender")) and file(cfg.get("nexrender")) and tmpl.get("composition") and tmpl.get("outputModule")
        if ready:
            result[kind] = True
            result["templates"].append({"id": key, "kind": kind})
    return result


def need_file(job, field, extensions=None):
    path = file(job.get(field))
    if not path or (extensions and path.suffix.lower() not in extensions):
        raise ValueError("缺少有效的本机素材：" + field)
    return path


def clone(cfg, job, out):
    interpreter = qwen_python(cfg)
    if not interpreter:
        raise ValueError("Qwen Python 环境不可用")
    if interpreter != Path(sys.executable).resolve():
        spec = out.parent / "voice-job.json"
        spec.write_text(json.dumps(job, ensure_ascii=False), encoding="utf-8")
        run([interpreter, Path(__file__).resolve(), "--job", spec, "--output", out], cwd=out.parent)
        return

    import soundfile
    import torch
    from qwen_tts import Qwen3TTSModel
    sample = need_file(job, "samplePath")
    text = job.get("text", "").strip()
    if not text or len(text) > 3600:
        raise ValueError("台词长度无效")
    reference = job.get("referenceText") or None
    device = cfg.get("qwenDevice", "cpu")
    if device not in ("cpu", "cuda:0"):
        raise ValueError("qwenDevice 需要 cpu 或 cuda:0")
    if device == "cpu":
        threads = cfg.get("qwenThreads", min(8, os.cpu_count() or 1))
        if type(threads) is not int or not 1 <= threads <= 64:
            raise ValueError("qwenThreads 需要 1 至 64 之间的整数")
        torch.set_num_threads(threads)
    model = Qwen3TTSModel.from_pretrained(cfg["qwenModel"], device_map=device,
                                          dtype=torch.float32 if device == "cpu" else torch.bfloat16,
                                          attn_implementation="eager", local_files_only=True)
    waves, rate = model.generate_voice_clone(text=text, language=cfg.get("qwenLanguage", "Auto"),
                                             ref_audio=str(sample), ref_text=reference,
                                             x_vector_only_mode=not bool(reference))
    if rate < 8000 or not len(waves) or not len(waves[0]):
        raise ValueError("未生成有效配音")
    soundfile.write(out, waves[0], rate, subtype="PCM_16")


def portrait(cfg, job, out):
    root = Path(cfg["museRoot"])
    # Upstream invokes ffmpeg itself. Pass private ASCII relative filenames to upstream.
    with tempfile.TemporaryDirectory(prefix="director_", dir=root) as tmp:
        work = Path(tmp)
        rel = work.relative_to(root)
        photo = need_file(job, "portraitPath", {".jpg", ".jpeg", ".webp", ".png", ".bmp", ".mp4", ".mov", ".m4v", ".webm", ".mkv", ".avi"})
        audio = need_file(job, "audioPath")
        run([cfg["ffmpeg"], "-nostdin", "-v", "error", "-i", photo, "-frames:v", "1", work / "face.png"])
        run([cfg["ffmpeg"], "-nostdin", "-v", "error", "-i", audio, "-map", "0:a:0", "-ar", "16000", "-ac", "1", work / "speech.wav"])
        (work / "tasks.json").write_text(json.dumps({"shot": {"video_path": (rel / "face.png").as_posix(),
            "audio_path": (rel / "speech.wav").as_posix(), "result_name": "final.mp4"}}), encoding="utf-8")
        run([cfg["musePython"], "-m", "scripts.inference", "--inference_config", rel / "tasks.json",
             "--result_dir", rel / "results", "--version", "v15", "--unet_model_path", "models/musetalkV15/unet.pth",
             "--unet_config", "models/musetalkV15/musetalk.json", "--ffmpeg_path", Path(cfg["ffmpeg"]).parent], cwd=root)
        result, = (work / "results").rglob("final.mp4")
        shutil.copyfile(result, out)


def motion(cfg, job, out, work):
    template = cfg["templates"][job["templateId"]]
    fields = job.get("fields") or {}
    if not isinstance(fields, dict) or any(k not in ("title", "subtitle", "product") or not isinstance(v, str) or len(v) > 3600 for k, v in fields.items()):
        raise ValueError("模板文本无效")
    if job["kind"] == "ae_template":
        assets = [{"type": "data", "layerName": name, "property": "Source Text", "value": fields[k]}
                  for k, name in template.get("textLayers", {}).items() if k in fields]
        if job.get("imagePath") and template.get("imageLayer"):
            assets.append({"type": "image", "layerName": template["imageLayer"], "src": need_file(job, "imagePath").as_uri()})
        payload = {"template": {"src": file(template["path"]).as_uri(), "composition": template["composition"],
                                "outputModule": template["outputModule"], "outputExt": "mov"}, "assets": assets,
                   "actions": {"postrender": [{"module": "@nexrender/action-copy", "input": "result.mov", "output": str(out)}]}}
        spec = work / "aep.json"
        spec.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        run([cfg["nexrender"], "--file", spec, "--workpath", work / "renders", "--binary", cfg["aerender"]], cwd=work)
    else:
        for key, low, high in (("width", 16, 4096), ("height", 16, 4096), ("fps", 1, 60), ("durationMs", 100, 600000)):
            if type(job.get(key)) is not int or not low <= job[key] <= high:
                raise ValueError("模板尺寸、帧率或时长无效")
        spec = work / "motion.json"
        args = {**job, "template": template, "ffmpeg": cfg["ffmpeg"], "modules": cfg["motionModules"],
                "chromium": cfg["chromium"], "output": str(out)}
        if job.get("imagePath"):
            args["imagePath"] = str(need_file(job, "imagePath", {".jpeg", ".jpg", ".webp", ".png", ".bmp"}))
        spec.write_text(json.dumps(args, ensure_ascii=False), encoding="utf-8")
        run([cfg["node"], MOTION.resolve(), spec], cwd=work)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--capabilities", action="store_true")
    parser.add_argument("--job")
    parser.add_argument("--output")
    args = parser.parse_args()
    cfg = read_config()
    caps = capabilities(cfg)
    if args.capabilities:
        print(json.dumps(caps))
        return
    job = read_json(args.job)
    kind = job.get("kind")
    if kind not in KINDS or not caps[kind]:
        raise ValueError("本机尚未配置所选媒体引擎")
    if kind in ("ae_template", "lottie", "pag") and {"id": job.get("templateId"), "kind": kind} not in caps["templates"]:
        raise ValueError("模板未在本机登记")
    target = Path(args.output)
    suffix = ".wav" if kind == "voice_clone" else ".mp4" if kind == "talking_head" else ".mov"
    if not target.is_absolute() or target.suffix.lower() != suffix or target.exists():
        raise ValueError("需要新的输出文件")
    with tempfile.TemporaryDirectory(prefix="director-", dir=target.parent) as tmp:
        work = Path(tmp)
        out = work / ("media" + suffix)
        if kind == "voice_clone":
            clone(cfg, job, out)
        elif kind == "talking_head":
            portrait(cfg, job, out)
        else:
            motion(cfg, job, out, work)
        if not out.is_file() or out.stat().st_size < 64:
            raise ValueError("引擎没有返回有效文件")
        # Atomic publication without replacing another invocation's output.
        os.link(out, target)


if __name__ == "__main__":
    try:
        main()
    except (ValueError, OSError, RuntimeError, ImportError, subprocess.SubprocessError) as error:
        print(str(error), file=sys.stderr)
        sys.exit(1)
