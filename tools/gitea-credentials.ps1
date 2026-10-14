# 凭据只存在 Windows 凭据管理器和调用进程内，不写入仓库或发布包。
function Get-DIYGiteaCredential {
    [CmdletBinding()]
    param()
    if (-not ('DIYTools.GiteaCredentialReader' -as [type])) {
        Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
namespace DIYTools {
    public static class GiteaCredentialReader {
        [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
        public struct Credential {
            public uint Flags; public uint Type; public string TargetName; public string Comment;
            public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
            public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
            public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
        }
        [DllImport("advapi32.dll", EntryPoint="CredReadW", CharSet=CharSet.Unicode, SetLastError=true)]
        public static extern bool Read(string target, uint type, uint flags, out IntPtr credential);
        [DllImport("advapi32.dll")] public static extern void CredFree(IntPtr credential);
    }
}
'@
    }
    $pointer = [IntPtr]::Zero
    if (-not [DIYTools.GiteaCredentialReader]::Read('DIYToolsRefactor.GiteaPublisher:gitea.cq360.top', 1, 0, [ref]$pointer)) {
        throw '尚未保存 Gitea 发布授权，请先运行 tools/authorize-gitea.ps1。'
    }
    try {
        $credential = [Runtime.InteropServices.Marshal]::PtrToStructure($pointer, [type][DIYTools.GiteaCredentialReader+Credential])
        if ($credential.CredentialBlobSize -eq 0 -or $credential.CredentialBlobSize % 2 -ne 0) { throw 'Gitea 本机凭据格式无效，请重新授权。' }
        $token = [Runtime.InteropServices.Marshal]::PtrToStringUni($credential.CredentialBlob, [int]($credential.CredentialBlobSize / 2))
        if ([string]::IsNullOrWhiteSpace($token)) { throw 'Gitea 本机凭据为空，请重新授权。' }
        # 返回值只能在发布进程内部使用，调用方不可输出或序列化此对象。
        return [pscustomobject]@{ UserName = $credential.UserName; Token = $token }
    } finally {
        if ($pointer -ne [IntPtr]::Zero) { [DIYTools.GiteaCredentialReader]::CredFree($pointer) }
    }
}
