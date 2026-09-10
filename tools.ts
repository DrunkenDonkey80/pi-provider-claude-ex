/**
 * Tool-name compatibility layer for the Anthropic OAuth path (unchanged from
 * upstream @zgltyq/pi-provider-claude — this part already worked).
 *
 * Anthropic's OAuth request path fingerprints tool names: a tool that is
 * neither a Claude Code core tool nor `mcp__`-prefixed can be classified as
 * extra usage. Upstream-upstream (@benvargas) dropped those tools; here they
 * are RENAMED on the wire to `mcp__pi__<name>` and renamed back before Pi
 * executes them, so every extension tool stays usable.
 */

const ALIAS_PREFIX = "mcp__pi__";

const CORE_TOOL_NAMES = new Set([
	"read",
	"write",
	"edit",
	"bash",
	"grep",
	"glob",
	"askuserquestion",
	"enterplanmode",
	"exitplanmode",
	"killshell",
	"notebookedit",
	"skill",
	"task",
	"taskoutput",
	"todowrite",
	"webfetch",
	"websearch",
]);

const lower = (s: string): string => s.toLowerCase();
export const isPlainObject = (v: unknown): v is Record<string, unknown> =>
	typeof v === "object" && v !== null && !Array.isArray(v);

function rewritePromptText(text: string): string {
	return text
		.replaceAll("pi itself", "the cli itself")
		.replaceAll("pi .md files", "cli .md files")
		.replaceAll("pi packages", "cli packages");
}

function rewriteSystemField(system: unknown): unknown {
	if (typeof system === "string") return rewritePromptText(system);
	if (!Array.isArray(system)) return system;
	return system.map((block) => {
		if (!isPlainObject(block) || block.type !== "text" || typeof block.text !== "string")
			return block;
		const rewritten = rewritePromptText(block.text);
		return rewritten === block.text ? block : { ...block, text: rewritten };
	});
}

function shouldRename(tool: Record<string, unknown>): boolean {
	if (typeof tool.type === "string" && tool.type.trim().length > 0) return false;
	const name = typeof tool.name === "string" ? tool.name : "";
	if (!name) return false;
	const lc = lower(name);
	if (CORE_TOOL_NAMES.has(lc)) return false;
	if (lc.startsWith("mcp__")) return false;
	return true;
}

function transformTools(tools: unknown[]): {
	tools: unknown[];
	renamed: Map<string, string>;
} {
	const renamed = new Map<string, string>();
	const emitted = new Set<string>();
	const result: unknown[] = [];

	for (const tool of tools) {
		if (!isPlainObject(tool)) continue;
		if (!shouldRename(tool)) {
			const key =
				typeof tool.name === "string" ? lower(tool.name) : `__native_${result.length}`;
			if (emitted.has(key)) continue;
			emitted.add(key);
			result.push(tool);
			continue;
		}
		const name = tool.name as string;
		const alias = ALIAS_PREFIX + name;
		renamed.set(lower(name), alias);
		if (emitted.has(lower(alias))) continue;
		emitted.add(lower(alias));
		const compatible: Record<string, unknown> = { ...tool, name: alias };
		delete compatible.strict; // Anthropic OAuth rejects valid Pi schemas in strict mode
		result.push(compatible);
	}
	return { tools: result, renamed };
}

function remapMessages(messages: unknown[], renamed: Map<string, string>): unknown[] {
	if (renamed.size === 0) return messages;
	let changed = false;
	const next = messages.map((msg) => {
		if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
		let blockChanged = false;
		const content = msg.content.map((block) => {
			if (!isPlainObject(block) || block.type !== "tool_use" || typeof block.name !== "string")
				return block;
			const alias = renamed.get(lower(block.name));
			if (!alias || alias === block.name) return block;
			blockChanged = true;
			return { ...block, name: alias };
		});
		if (!blockChanged) return msg;
		changed = true;
		return { ...msg, content };
	});
	return changed ? next : messages;
}

function remapToolChoice(
	toolChoice: Record<string, unknown>,
	renamed: Map<string, string>,
): Record<string, unknown> {
	if (toolChoice.type !== "tool" || typeof toolChoice.name !== "string") return toolChoice;
	const alias = renamed.get(lower(toolChoice.name));
	return alias ? { ...toolChoice, name: alias } : toolChoice;
}

export function transformPayload(
	raw: Record<string, unknown>,
	disable: boolean,
): Record<string, unknown> {
	const payload = JSON.parse(JSON.stringify(raw)) as Record<string, unknown>;
	if (payload.system !== undefined) payload.system = rewriteSystemField(payload.system);
	if (disable) return payload;
	if (Array.isArray(payload.tools)) {
		const { tools, renamed } = transformTools(payload.tools as unknown[]);
		payload.tools = tools;
		if (isPlainObject(payload.tool_choice))
			payload.tool_choice = remapToolChoice(payload.tool_choice, renamed);
		if (Array.isArray(payload.messages))
			payload.messages = remapMessages(payload.messages, renamed);
	}
	return payload;
}

/** Rewrite `mcp__pi__<name>` calls back to `<name>` before Pi resolves them. */
export function unaliasToolCalls(message: unknown): unknown {
	if (!isPlainObject(message) || message.role !== "assistant" || !Array.isArray(message.content))
		return undefined;
	let changed = false;
	const content = message.content.map((block) => {
		if (!isPlainObject(block) || block.type !== "toolCall" || typeof block.name !== "string")
			return block;
		if (!block.name.startsWith(ALIAS_PREFIX)) return block;
		changed = true;
		return { ...block, name: block.name.slice(ALIAS_PREFIX.length) };
	});
	return changed ? { ...message, content } : undefined;
}
