import 'server-only';
import https from 'https';
import http from 'http';
import dns from 'dns';

/**
 * macOS `mDNSResponder` 在切网络 / 长时间运行后偶尔会对某些域名（例如
 * *.cognitiveservices.azure.com）的 getaddrinfo 永久挂住，表现为 Node fetch / axios
 * 报 `UND_ERR_CONNECT_TIMEOUT` 或 `getaddrinfo ENOTFOUND`，但 `dig` / `dns.resolve4`
 * 立刻能拿到正确 IP，TCP 也通。
 *
 * 这里提供一个绕过：自定义 lookup 直接走 `dns.resolve4 / resolve6`（独立于系统
 * 解析器），完全跳过 mDNSResponder。
 */
function customLookup(
  hostname: string,
  optionsOrCb: dns.LookupOneOptions | dns.LookupAllOptions | ((err: NodeJS.ErrnoException | null, address: string, family: number) => void),
  cb?: (err: NodeJS.ErrnoException | null, address: string | dns.LookupAddress[], family: number) => void
): void {
  const callback = (typeof optionsOrCb === 'function' ? optionsOrCb : cb)!;
  const options = (typeof optionsOrCb === 'function' ? {} : optionsOrCb) as dns.LookupAllOptions;
  const all = options.all === true;

  // 先 IPv4，再 IPv6
  dns.resolve4(hostname, (err4, addrs4) => {
    if (!err4 && addrs4 && addrs4.length > 0) {
      if (all) {
        return (callback as any)(
          null,
          addrs4.map((address) => ({ address, family: 4 }))
        );
      }
      return (callback as any)(null, addrs4[0], 4);
    }
    dns.resolve6(hostname, (err6, addrs6) => {
      if (!err6 && addrs6 && addrs6.length > 0) {
        if (all) {
          return (callback as any)(
            null,
            addrs6.map((address) => ({ address, family: 6 }))
          );
        }
        return (callback as any)(null, addrs6[0], 6);
      }
      // 都失败时再退回系统 getaddrinfo（让用户看到原生错误）
      (dns.lookup as any)(hostname, options, callback);
    });
  });
}

/**
 * 复用单例，但不复用空闲 socket。
 *
 * 之前 keepAlive=true 时，dev server 长时间闲置后 Azure 请求偶发 45s 超时；
 * 重启 `npm run dev` 会恢复，本质上就是清掉了陈旧连接池。AI 请求更看重稳定，
 * 这里禁用 keep-alive，让每次请求重新建 TLS 连接并重新走 customLookup。
 */
export const httpsAgentWithCustomDns = new https.Agent({
  keepAlive: false,
  lookup: customLookup as unknown as https.AgentOptions['lookup']
});

export const httpAgentWithCustomDns = new http.Agent({
  keepAlive: false,
  lookup: customLookup as unknown as http.AgentOptions['lookup']
});
