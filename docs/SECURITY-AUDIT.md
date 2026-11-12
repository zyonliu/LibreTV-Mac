# 桌面增强层依赖审计与修复

2026-11-12，适用于 LibreTV Mac 1.0.0/build 4。

## 审计边界

用户要求仅扫描我们自己的代码。范围为桌面工程的 lockfile（含开发依赖）、实际 Desktop/node_modules、原生桥与 Runtime、我们内置的 Node。**官方 LibreTV Core 和用户以后更新的 Core 全部排除，不给它们套桌面依赖覆盖，也不把桌面 0 命中结论延伸到官方包。** 原包完整性和接口兼容另行验证。

## 修复

修复前 npm 生产依赖命中 5 个包（1 critical、4 high），全量依赖命中 18 个包。修复后全量、生产与实际桌面载荷检查均为 0。没有 ignore 漏洞条目、禁用安全规则或使用 --force/--legacy-peer-deps 绕过兼容性。

| 桌面依赖 | 修复前 | 修复后 |
| --- | --- | --- |
| next | 15.5.26 | 15.5.29 |
| undici | 6.21.1 | 6.29.1 |
| postcss | 8.5.28 | 8.5.32 |
| source-map-js | 1.2.1 | 1.2.2 |
| sharp | 0.35.4 | 0.35.5 |
| vitest | 2.1.9 | 5.1.0 |
| vite | 5.4.21 | 8.3.8 |
| eslint-config-next | 15.5.26 | 15.5.29 |
| Node 运行时 | 24.16.0 | 24.22.3 LTS 安全版 |

Next 自带的 PostCSS 固定依赖通过桌面 overrides 指向 8.5.32；source-map-js 同步修复。Next ESLint 配置宽泛的依赖范围曾选到不支持 ESLint 9 的旧解析器，现固定插件与解析器 8.72.2，并仅为 typescript-estree 覆盖已修复的 minimatch 11.x。npm ls、干净重装、lint、typecheck、622 项用例验证其兼容性；未来上游修复依赖声明后可移除覆盖，再重新检查。

Vitest/Vite 升级后使用 .mts 配置，保留整个工程 CommonJS 边界，避免影响 Next standalone。没有设置整个 package 的 type=module 或抑制工具告警。

## 可复现门禁

scripts/runtime-config.json 集中维护 Node 版本，upstream-lock.json 固定官方 SHA；归档在解包及执行前校验。构建先 npm ci --ignore-scripts，随后在线审计。打包再次运行 scripts/audit-desktop.mjs，并校验载荷中的桌面 lockfile 与源文件字节一致。

门禁查询 npm 全量/生产审计、实际 Desktop 包版本、Node 内嵌 Undici、Node 官方安全数据库与支持期。批量查询附带已知受影响的 Undici 6.21.1 正对照，防止把空响应或代理错误当成 0；它不属于交付依赖。网络失败、无有效元数据、版本不匹配或命中漏洞都会非零退出。

原始请求/响应、版本清单、范围、时间和 lock SHA 见 verification/security；修复前 npm 结果见 verification/security-before。框架内部未标版本的合并库以框架自身公告为覆盖依据，不能将版本元数据检查解释为不存在未知漏洞。

原生增强层复核继续保留同源/frame/方法限制、随机 HttpOnly cookie、目录和文件名验证、缓存标记/符号链接检查、有界传输与专属进程组回收。新增旧网页卸载回归；官方 Core 文件未改写。

## 主要来源

- [Next.js 15.5.29 官方安全版本](https://github.com/vercel/next.js/releases/tag/v15.5.29)
- [Undici TLS 校验修复](https://github.com/advisories/GHSA-2m5v-pch6-74hx)
- [PostCSS 修复依据](https://github.com/advisories/GHSA-fxqj-rqcc-2cmp)
- [Minimatch 修复依据](https://github.com/advisories/GHSA-g3hv-75wg-m249)
- [Node 24.22.3 官方安全发布与 SHA](https://nodejs.org/en/blog/release/v24.22.3)
- [Node 安全数据库](https://github.com/nodejs/security-wg/tree/main/vuln/core)

Local 策略沿用用户选择：ad-hoc app、无 Installer 签名、未公证。正式分发信任、干净 Mac 和最低系统实机验收另有要求，不与依赖审计混为一项。
