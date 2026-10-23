"""公开独立 Excel 读取器：不导入 ERP、凭据或网络适配器。"""
import json
import sys
from cost_file import read_costs

def serve():
    while True:
        line=sys.stdin.buffer.readline(65537)
        if not line:return
        request_id=""
        try:
            if len(line)>65536:
                while line and not line.endswith(b"\n"):line=sys.stdin.buffer.readline(65537)
                raise ValueError("input too large")
            request=json.loads(line)
            if not isinstance(request,dict):raise ValueError("invalid request")
            request_id=request.get("id","")
            if not isinstance(request_id,str) or len(request_id)>256:raise ValueError("invalid id")
            if request.get("action")!="sql_cost_file":raise ValueError("invalid action")
            result=read_costs(request.get("settings",{}))
            response={"id":request_id,"ok":True,"result":result}
        except Exception:
            response={"id":request_id,"ok":False,"error":{"code":"COST_FILE_ERROR"}}
        encoded=json.dumps(response,ensure_ascii=False,allow_nan=False)
        if len(encoded.encode('utf8'))>32*1024*1024:
            encoded=json.dumps({"id":request_id,"ok":False,"error":{"code":"OUTPUT_TOO_LARGE"}})
        sys.stdout.buffer.write((encoded+"\n").encode('utf8'));sys.stdout.buffer.flush()
if __name__=="__main__":serve()
