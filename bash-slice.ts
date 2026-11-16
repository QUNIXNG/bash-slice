/**
 * bash-slice 扩展 — 终端输出切片（单文件，逻辑与钩子在一起）
 *
 * 用途：把 bash / powershell 的大块 stdout+stderr 压成「头部 + 关键行 + 尾部」，省 token，
 *      同时不丢「原文一定在盘上」这条底线——pi 内置截断已经把全量写到 details.fullOutputPath。
 *      两份都要压：content[*].text（模型直接读的）和 structuredContent.output（bash 回填的全文副本），
 *      只压前者等于没省。
 *
 * 口径（写死，不随数据漂移）：
 *   - 按 \n 切行；行内含 \r（进度条反复刷新）只保留最后一次刷新的内容
 *   - ANSI 颜色 / 光标控制序列剥掉（纯噪音）；不带切片标记的文本才处理（幂等）
 *   - 触发门槛：行数 > 120 或字节 > 8192，且至少省 15%，否则原样返回
 *   - 保留：头 40 行 + 尾 60 行 + 中间区命中报错正则的行（上限 40）
 *   - 尾注只在拿到 fullOutputPath 时才写路径，没落盘就明说没有
 *
 * 为什么是单文件：`/reload` 只重载 `extensions/` 下的入口文件，入口 import 的
 * `lib/*.mjs` 走 jiti 模块缓存不刷新（2026-11-13 实测：`/slice status` 计数归零说明入口重载了，
 * 但 lib 里改的尾注文案没跟着变）。并成单文件后改逻辑 `/reload` 就够。
 *
 * 自检：`/slice selftest` —— 同时验纯函数和钩子接线。
 *       另外每次 session_start 会静默跑一次（微秒级），失败且毛病没变才弹通知，
 *       所以升级 pi 之后不用记着手动跑；自愈后标记会自己清掉。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { isBashToolResult, isPowerShellToolResult } from "@earendil-works/pi-coding-agent";
import type { BashToolResultEvent, ExtensionAPI, PowerShellToolResultEvent } from "@earendil-works/pi-coding-agent";

const STATE_FILE = process.env.BASH_SLICE_STATE || join(homedir(), ".pi", "agent", "lib", "bash-slice", "state.json");
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]|\x1b\][^\u0007]*\u0007|\x1b[()][A-Z0-9]/g;
const MARK = "…[省略 ";

/** 关键行：报错、失败、超时、告警——构建/测试里真正要看的那些 */
const INTERESTING = new RegExp(
	[
		"error",
		"err\\b",
		"fail(ed|ure|ing)?",
		"fatal",
		"exception",
		"panic",
		"traceback",
		"segfault",
		"denied",
		"refused",
		"unhandled",
		"timed? ?out",
		"crashed",
		"warn(ing)?",
		"错误",
		"失败",
		"异常",
		"超时",
		"警告",
		"未找到",
		"不存在",
	].join("|"),
	"i",
);

const DEFAULTS = {
	headLines: 40,
	tailLines: 60,
	interestingMax: 40,
	triggerLines: 120,
	triggerBytes: 8192,
	minSaving: 0.15,
};

type SliceOpts = Partial<typeof DEFAULTS> & { fullPath?: string | null };
type SliceStats = { totalLines: number; outLines: number; inBytes: number; outBytes: number; keptInteresting: number };
type SliceResult = { text: string; sliced: boolean; stats: SliceStats };

function fmtBytes(n: number): string {
	if (n < 1024) return `${n} B`;
	if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
	return `${(n / 1024 / 1024).toFixed(2)} MB`;
}

/** 去掉 ANSI 码，并把 \r 进度条折成最后状态 */
function normalize(raw: string): string[] {
	const out: string[] = [];
	for (const line of String(raw ?? "").replace(ANSI, "").split("\n")) {
		const i = line.lastIndexOf("\r");
		out.push(i >= 0 ? line.slice(i + 1) : line);
	}
	return out;
}

export function sliceOutput(raw: string, opts: SliceOpts = {}): SliceResult {
	const o = { ...DEFAULTS, ...opts };
	const lines = normalize(raw);
	const text0 = lines.join("\n");
	const totalLines = lines.length;
	const inBytes = Buffer.byteLength(text0);
	const stats: SliceStats = { totalLines, outLines: totalLines, inBytes, outBytes: inBytes, keptInteresting: 0 };

	if (text0.includes(MARK)) return { text: text0, sliced: false, stats };
	if (totalLines <= o.triggerLines && inBytes <= o.triggerBytes) return { text: text0, sliced: false, stats };
	// 头尾之外没有可省的空间就别动
	if (totalLines <= o.headLines + o.tailLines + 10) return { text: text0, sliced: false, stats };

	const head = lines.slice(0, o.headLines);
	const tail = lines.slice(totalLines - o.tailLines);
	const middle = lines.slice(o.headLines, totalLines - o.tailLines);

	const interesting: string[] = [];
	for (const line of middle) {
		if (!INTERESTING.test(line)) continue;
		interesting.push(line);
		if (interesting.length >= o.interestingMax) break;
	}

	const parts = [...head];
	if (middle.length > 0) parts.push(`${MARK}${middle.length} 行]…`);
	if (interesting.length > 0) {
		parts.push(`[切片保留 ${interesting.length} 条关键行]`);
		parts.push(...interesting);
		if (interesting.length >= o.interestingMax) parts.push(`[关键行已截到 ${o.interestingMax} 条上限，其余见全量原文]`);
	}
	parts.push(...tail);

	let text = parts.join("\n");
	const outBytes = Buffer.byteLength(text);
	const savedRatio = inBytes > 0 ? 1 - outBytes / inBytes : 0;
	if (savedRatio < o.minSaving) return { text: text0, sliced: false, stats };

	const where = o.fullPath
		? `全量原文：${o.fullPath}`
		: "原文未落盘，要全量请重跑并重定向（> out.log 2>&1），或用 rg 精炼";
	text += `\n[已切片] ${totalLines} 行 / ${fmtBytes(inBytes)} → ${parts.length} 行 / ${fmtBytes(outBytes)}（省 ${Math.round(savedRatio * 100)}%）；${where}`;

	return {
		text,
		sliced: true,
		stats: { totalLines, outLines: parts.length + 1, inBytes, outBytes: Buffer.byteLength(text), keptInteresting: interesting.length },
	};
}

// 本会话计数：`/slice status` 能打出「真的触发过几次」，避免静默不生效
let fired = 0;
let savedBytes = 0;
let lastStats: string | null = null;

type SliceState = { enabled?: boolean; lastPiVersion?: string | null; lastFailSignature?: string };

function readState(): SliceState {
	try {
		const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as unknown;
		return raw && typeof raw === "object" ? (raw as SliceState) : {};
	} catch {
		return {};
	}
}

/** 合并写回：`/slice on|off` 只动 enabled，自检只动 lastPiVersion / lastFailSignature，互不覆盖 */
function patchState(patch: SliceState): void {
	mkdirSync(dirname(STATE_FILE), { recursive: true });
	writeFileSync(STATE_FILE, `${JSON.stringify({ ...readState(), ...patch }, null, 2)}\n`);
}

function readEnabled(): boolean {
	return readState().enabled !== false;
}

function writeEnabled(enabled: boolean): void {
	patchState({ enabled });
}

/** pi 版本：从依赖包自己的 package.json 读，pi 一升级这个值就变 */
function piVersion(): string | null {
	try {
		const req = createRequire(import.meta.url);
		let dir = dirname(req.resolve("@earendil-works/pi-coding-agent"));
		for (let i = 0; i < 6; i += 1) {
			const candidate = join(dir, "package.json");
			if (existsSync(candidate)) {
				const pkg = JSON.parse(readFileSync(candidate, "utf8")) as { name?: string; version?: string };
				if (pkg.name === "@earendil-works/pi-coding-agent" && pkg.version) return pkg.version;
			}
			dir = dirname(dir);
		}
	} catch {
		// 解析不到就当没有版本，下次会话还会再试
	}
	return null;
}

type ShellResultEvent = BashToolResultEvent | PowerShellToolResultEvent;

/** 钩子本体；单独抽出来是为了 `/slice selftest` 能直接打同一条路径 */
function sliceResultEvent(event: ShellResultEvent): { content: ShellResultEvent["content"]; structuredContent?: unknown } | undefined {
	// 钩子已经过滤过一遍；这里再核一次，让 selftest 能直接打单条路径
	const name = (event as { toolName?: string }).toolName;
	if (name !== "bash" && name !== "powershell") return undefined;
	if (!readEnabled()) return undefined;
	if (!event.content || event.content.length === 0) return undefined;

	// 只有 pi 内置截断真的落盘了才有 fullOutputPath，没落盘就别写路径
	const fullPath = (event.details as { fullOutputPath?: string } | undefined)?.fullOutputPath;
	let cut = false;

	const content = event.content.map((block) => {
		if (block.type !== "text") return block;
		const r = sliceOutput(block.text, { fullPath });
		if (!r.sliced) return block;
		cut = true;
		fired += 1;
		savedBytes += r.stats.inBytes - r.stats.outBytes;
		lastStats = `${r.stats.totalLines}→${r.stats.outLines} 行，保留关键行 ${r.stats.keptInteresting} 条`;
		return { ...block, text: r.text };
	});
	if (!cut) return undefined;

	// structuredContent 里也有一份全文，不同步压就等于没省
	let structuredContent = event.structuredContent;
	if (structuredContent && typeof structuredContent === "object" && typeof (structuredContent as { output?: unknown }).output === "string") {
		const r = sliceOutput((structuredContent as { output: string }).output, { fullPath });
		if (r.sliced) structuredContent = { ...(structuredContent as Record<string, unknown>), output: r.text };
	}
	return { content, structuredContent };
}

export default function (pi: ExtensionAPI) {
	// 切片靠 tool_result 钩子的签名/事件形状，pi 一升级就可能静默失效。
	// 每次开新会话跑一次自检（微秒级开销），失败且毛病没变才通知，避免反复喊。
	pi.on("session_start", async (_event, ctx) => {
		// 自检会走 sliceResultEvent，别把这几次算进本会话用量
		const before = { fired, savedBytes, lastStats };
		const report = selftest();
		fired = before.fired;
		savedBytes = before.savedBytes;
		lastStats = before.lastStats;

		const state = readState();
		const version = piVersion();
		if (!report.startsWith("selftest FAIL")) {
			// 自愈了就清掉标记，下次再坏会重新提醒
			if (state.lastFailSignature) patchState({ lastFailSignature: undefined, lastPiVersion: version ?? state.lastPiVersion });
			return;
		}
		if (state.lastFailSignature === report) return;
		patchState({ lastFailSignature: report, lastPiVersion: version ?? state.lastPiVersion });
		ctx.ui.notify(`bash-slice 自检没过，终端输出切片可能已静默失效${version ? `（pi ${version}）` : ""}：\n${report}`, "error");
	});

	pi.on("tool_result", async (event) => {
		if (!isBashToolResult(event) && !isPowerShellToolResult(event)) return;
		return sliceResultEvent(event);
	});

	pi.registerCommand("slice", {
		description: "终端输出切片：/slice on|off|status|selftest",
		handler: async (args, ctx) => {
			const arg = String(args ?? "").trim().toLowerCase();
			if (arg === "on" || arg === "off") {
				writeEnabled(arg === "on");
				ctx.ui.notify(`输出切片已${arg === "on" ? "开启" : "关闭"}（写 ${STATE_FILE}）`, "info");
				return;
			}
			if (arg === "selftest") {
				ctx.ui.notify(selftest(), "info");
				return;
			}
			ctx.ui.notify(
				[
					`输出切片：${readEnabled() ? "开启" : "关闭"}`,
					`本会话触发 ${fired} 次，累计省 ${Math.round(savedBytes / 1024)} KB`,
					lastStats ? `最近一次：${lastStats}` : "最近一次：无",
					`规则：${import.meta.url.replace(/^file:\/\/\//, "").replace(/\//g, "\\")}`,
				].join("\n"),
				"info",
			);
		},
	});
}

/** 自检：纯函数 + 钩子接线，任一失败直接列出来 */
function selftest(): string {
	const fails: string[] = [];
	const ok = (name: string, cond: boolean, extra = "") => {
		if (!cond) fails.push(`${name}${extra ? `（${extra}）` : ""}`);
	};

	const small = Array.from({ length: 30 }, (_, i) => `line ${i}`).join("\n");
	const r1 = sliceOutput(small);
	ok("30 行原样返回", !r1.sliced && r1.text === small);

	const body: string[] = [];
	for (let i = 0; i < 500; i += 1) {
		if (i === 37 || i === 210 || i === 411) body.push(`src/mod${i}.ts:12:3 - error TS2322: Type 'string' is not assignable`);
		else if (i === 300) body.push("warning: unused import");
		else body.push(`[build] compiling module ${i} ...`);
	}
	const big = body.join("\n");
	const r2 = sliceOutput(big);
	ok("500 行触发切片", r2.sliced);
	ok("省下 >50%", r2.sliced && r2.stats.outBytes / r2.stats.inBytes < 0.5, r2.sliced ? `剩 ${Math.round((r2.stats.outBytes / r2.stats.inBytes) * 100)}%` : "");
	ok("保住尾 60 行", r2.text.includes("[build] compiling module 499 ..."));
	ok("头部报错仍在", r2.text.includes("src/mod37.ts"));
	ok("中段关键行 = 3", r2.stats.keptInteresting === 3, `实际 ${r2.stats.keptInteresting}`);
	ok("没给路径就直说未落盘", r2.text.includes("原文未落盘") && !r2.text.includes("全量原文："));
	ok("给了路径就写路径", sliceOutput(big, { fullPath: "C:/tmp/full.log" }).text.includes("全量原文：C:/tmp/full.log"));
	ok("ANSI 剥干净", !normalize("\x1b[31merror\x1b[0m: x")[0].includes("\x1b"));
	const bar = normalize("10%\r50%\r100% done\nok");
	ok("进度条折成最后状态", bar[0] === "100% done" && bar[1] === "ok");
	ok("二次切片不动", !sliceOutput(r2.text).sliced);
	ok("省不够就不切", !sliceOutput(Array.from({ length: 130 }, (_, i) => `x${i}`).join("\n"), { minSaving: 0.95 }).sliced);

	// 钩子接线：走 sliceResultEvent 而不是直接调 sliceOutput
	const enabledBefore = readEnabled();
	const hookEvent = {
		type: "tool_result",
		toolName: "bash",
		toolCallId: "selftest",
		input: {},
		isError: false,
		content: [{ type: "text", text: big }],
		structuredContent: { output: big, truncated: false, exit_code: 0 },
		details: {},
	} as unknown as ShellResultEvent;
	const hookOut = sliceResultEvent(hookEvent);
	if (!enabledBefore) {
		ok("钩子接线（当前 /slice off，跳过）", true);
	} else {
		ok("钩子压了 content", Boolean(hookOut) && String((hookOut?.content?.[0] as { text?: string })?.text).includes("…[省略 "));
		const sc = hookOut?.structuredContent as { output?: string; exit_code?: number } | undefined;
		ok("钩子压了 structuredContent", Boolean(sc?.output?.includes("…[省略 ")));
		ok("其他字段保留", sc?.exit_code === 0);
		const passthrough = sliceResultEvent({ ...hookEvent, content: [{ type: "text", text: "a\nb" }] } as unknown as ShellResultEvent);
		ok("小输出不碰", passthrough === undefined);
		const other = sliceResultEvent({ ...hookEvent, toolName: "grep" } as unknown as ShellResultEvent);
		ok("非 shell 工具不碰", other === undefined);
	}

	return fails.length === 0 ? "selftest PASS（13 项纯函数 + 钩子接线全过）" : `selftest FAIL ${fails.length} 项：\n${fails.join("\n")}`;
}
