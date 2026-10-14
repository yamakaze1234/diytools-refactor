# 发布者只需执行一次：隐藏输入并验证令牌，随后仅存入 Windows 凭据管理器。
$ErrorActionPreference = 'Stop'
$secret = Read-Host '粘贴 Gitea 发布令牌（输入隐藏，按回车确认）' -AsSecureString
$pointer = [Runtime.InteropServices.Marshal]::SecureStringToCoTaskMemUnicode($secret)
try {
    $token = [Runtime.InteropServices.Marshal]::PtrToStringUni($pointer)
    if ([string]::IsNullOrWhiteSpace($token)) { throw '令牌不能为空' }
    try {
        $member = Invoke-RestMethod -Uri 'https://gitea.cq360.top/api/v1/user' -Headers @{Authorization="token $token"} -MaximumRedirection 0 -TimeoutSec 20
    } catch { throw '授权验证失败：请确认令牌有效，并包含 user 读取权限。令牌未保存。' }
    if (-not $member.login) { throw '未读取到有效账户，令牌未保存。' }
    Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class DIYGiteaCredential {
    [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
    public struct Credential {
        public uint Flags; public uint Type; public string TargetName; public string Comment;
        public System.Runtime.InteropServices.ComTypes.FILETIME LastWritten;
        public uint CredentialBlobSize; public IntPtr CredentialBlob; public uint Persist;
        public uint AttributeCount; public IntPtr Attributes; public string TargetAlias; public string UserName;
    }
    [DllImport("advapi32.dll", EntryPoint="CredWriteW", CharSet=CharSet.Unicode, SetLastError=true)]
    public static extern bool Write(ref Credential value, uint flags);
}
"@
    $credential = [DIYGiteaCredential+Credential]::new()
    $credential.Type = 1
    $credential.TargetName = 'DIYToolsRefactor.GiteaPublisher:gitea.cq360.top'
    $credential.Comment = 'DIY Tools Gitea publisher; not distributed with application'
    $credential.UserName = [string]$member.login
    $credential.Persist = 2
    $credential.CredentialBlobSize = [Text.Encoding]::Unicode.GetByteCount($token)
    $credential.CredentialBlob = $pointer
    if (-not [DIYGiteaCredential]::Write([ref]$credential,0)) { throw 'Windows 凭据保存失败。' }
    Write-Host "授权已保存，当前账户：$($member.login)。可以回到聊天回复：已授权。"
} finally {
    $token = $null
    [Runtime.InteropServices.Marshal]::ZeroFreeCoTaskMemUnicode($pointer)
    $secret.Dispose()
}
