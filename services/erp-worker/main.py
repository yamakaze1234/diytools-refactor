# ERP 子进程的 JSONL 协议入口：默认只报告环境，--serve 才接收请求；标准输出仅承载协议响应。
"""Default: environment report. --serve: memory-only ERP JSONL worker."""

import importlib
import importlib.metadata
import json
import platform
import sys

from session import Session, WorkerError, silence_sdk, load_adapter, local_erp_config

MAX_INPUT = 64 * 1024
MAX_OUTPUT = 2 * 1024 * 1024
MAX_SQL_OUTPUT = 32 * 1024 * 1024


# 分别检查包是否安装及入口能否导入；导入成功只表示依赖可用，不表示登录成功。
def check_package() -> dict:
    try:
        config = local_erp_config()
        if not config.get("domain"):
            return {"status": "missing", "version": None, "message": "本机尚未配置 ERP 适配器"}
        with silence_sdk():
            module = load_adapter(config)
        return {"status": "ready", "version": str(getattr(module, "VERSION", "external-adapter")), "message": "本机 ERP 适配器可加载；尚未验证登录和查询"}
    except WorkerError as error:
        status = "missing" if error.code == "PACKAGE_UNAVAILABLE" else "error"
        return {"status": status, "version": None, "message": error.message}
    except Exception:
        return {"status": "error", "version": None, "message": "本机 ERP 适配器加载失败"}


# 返回宿主诊断所需的版本信息，明确标记尚未连接 ERP。
def environment_report() -> dict:
    return {
        "service": "diytools-erp-worker",
        "python": platform.python_version(),
        "executable": sys.executable,
        "platform": sys.platform,
        "erp_package": check_package(),
        "erp_connected": False,
    }


def error_response(request_id, code, message):
    return {"id": request_id, "ok": False, "error": {"code": code, "message": message}}


# 按行关联请求 ID；超长输入整行排空后继续服务，异常转换成不含底层凭据的固定错误。
def serve(input_stream=None, output_stream=None, session=None):
    input_stream = input_stream if input_stream is not None else sys.stdin.buffer
    output_stream = output_stream if output_stream is not None else sys.stdout
    session = session if session is not None else Session()
    try:
        while True:
            line = input_stream.readline(MAX_INPUT + 1)
            if not line:
                break
            request_id = ""
            output_limit = MAX_OUTPUT
            try:
                if len(line) > MAX_INPUT:
                    while line and not line.endswith(b"\n"):
                        line = input_stream.readline(MAX_INPUT + 1)
                    raise WorkerError("INPUT_TOO_LARGE", "请求超过 64 KiB 限制")
                request = json.loads(line.decode("utf-8"), parse_constant=lambda value: (_ for _ in ()).throw(ValueError()))
                if isinstance(request, dict) and isinstance(request.get("id"), str) and len(request["id"]) <= 256:
                    request_id = request["id"]
                if isinstance(request, dict) and request.get("action") in {"sql_read", "sql_cost_file"}:
                    output_limit = MAX_SQL_OUTPUT
                result = session.handle(request)
                response = {"id": request_id, "ok": True, "result": result}
            except WorkerError as error:
                response = error_response(request_id, error.code, error.message)
            except (ValueError, UnicodeError, RecursionError):
                response = error_response(request_id, "INVALID_REQUEST", "请求 JSON 格式无效")
            except Exception:
                response = error_response(request_id, "INTERNAL_ERROR", "ERP 服务暂不可用")
            try:
                encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
                if len(encoded.encode("utf-8")) + 1 > output_limit:
                    encoded = json.dumps(error_response(request_id, "OUTPUT_TOO_LARGE", "ERP 返回数据超过允许大小"), ensure_ascii=False)
                output_stream.write(encoded + "\n")
                output_stream.flush()
            except (BrokenPipeError, OSError):
                break
    finally:
        session.disconnect()


# 只支持环境检查和常驻协议两种启动方式，统一 UTF-8 避免中文通过管道乱码。
def main() -> None:
    sys.stdout.reconfigure(encoding="utf-8")
    sys.stderr.reconfigure(encoding="utf-8")
    if sys.argv[1:] == ["--serve"]:
        serve()
    elif not sys.argv[1:]:
        print(json.dumps(environment_report(), ensure_ascii=False))
    else:
        print(json.dumps(error_response("", "INVALID_REQUEST", "启动参数无效"), ensure_ascii=False))


if __name__ == "__main__":
    main()
