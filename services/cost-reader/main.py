"""公开独立 Excel 读取器：不导入 ERP、凭据或网络适配器。"""
import json
import sys
from cost_file import read_costs
from quotation_file import read_quotations

def serve():
    while True:
        line=sys.stdin.buffer.readline(65537)
        if not line:return
        request_id=""
        action=None
        try:
            if len(line)>65536:
                while line and not line.endswith(b"\n"):line=sys.stdin.buffer.readline(65537)
                raise ValueError("input too large")
            request=json.loads(line)
            if not isinstance(request,dict):raise ValueError("invalid request")
            request_id=request.get("id","")
            if not isinstance(request_id,str) or len(request_id)>256:raise ValueError("invalid id")
            action=request.get("action")
            # NAS 维护表和含税成本表都走这个内置无网络读取器，但两者使用不同表与业务列。
            if action=="sql_cost_file":
                result=read_costs(request.get("settings",{}))
            elif action=="nas_quotation_file":
                result=read_quotations(request["settings"]["path"])
            else:
                raise ValueError("invalid action")
            response={"id":request_id,"ok":True,"result":result}
        except Exception:
            response={"id":request_id,"ok":False,"error":{"code":"QUOTATION_FILE_ERROR" if action=="nas_quotation_file" else "COST_FILE_ERROR"}}
        encoded=json.dumps(response,ensure_ascii=False,allow_nan=False)
        if len(encoded.encode('utf8'))>32*1024*1024:
            encoded=json.dumps({"id":request_id,"ok":False,"error":{"code":"OUTPUT_TOO_LARGE"}})
        sys.stdout.buffer.write((encoded+"\n").encode('utf8'));sys.stdout.buffer.flush()
if __name__=="__main__":serve()
