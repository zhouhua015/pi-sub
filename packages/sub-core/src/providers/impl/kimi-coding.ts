/**
 * Kimi Coding usage provider
 */

import * as path from "node:path";
import type { Dependencies, RateWindow, UsageSnapshot } from "../../types.js";
import { BaseProvider } from "../../provider.js";
import { noCredentials, fetchFailed, httpError } from "../../errors.js";
import { formatReset, createTimeoutController } from "../../utils.js";
import { API_TIMEOUT_MS } from "../../config.js";

/**
 * Load Kimi Coding API key from environment or auth.json
 */
function loadKimiCodingApiKey(deps: Dependencies): string | undefined {
	// Try environment variable first
	const envKey = deps.env.KIMI_API_KEY?.trim();
	if (envKey) return envKey;

	// Try pi auth.json
	const authPath = path.join(deps.homedir(), ".pi", "agent", "auth.json");
	try {
		if (deps.fileExists(authPath)) {
			const auth = JSON.parse(deps.readFile(authPath) ?? "{}");
			return auth["kimi-coding"]?.access || auth["kimi-coding"]?.key;
		}
	} catch {
		// Ignore parse errors
	}

	return undefined;
}

function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string") {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

type KimiLimit = {
	window?: {
		duration?: number;
		timeUnit?: string;
	};
	detail?: Record<string, unknown>;
};

type KimiUsageResponse = {
	usage?: Record<string, unknown>;
	limits?: KimiLimit[];
};

function parseResetAt(value: unknown): Date | undefined {
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return new Date(parsed);
	}
	if (typeof value === "number" && Number.isFinite(value)) {
		return new Date(value > 1_000_000_000_000 ? value : value * 1000);
	}
	return undefined;
}

function findResetDate(obj: Record<string, unknown>): Date | undefined {
	for (const key of ["reset_at", "resetAt", "reset_time", "resetTime"]) {
		const date = parseResetAt(obj[key]);
		if (date) return date;
	}
	return undefined;
}

function computeUsedPercent(used: number | undefined, limit: number | undefined, remaining: number | undefined): number {
	if (used !== undefined && limit !== undefined && limit > 0) {
		return Math.min(Math.max((used / limit) * 100, 0), 100);
	}
	if (remaining !== undefined && limit !== undefined && limit > 0) {
		return Math.min(Math.max(((limit - remaining) / limit) * 100, 0), 100);
	}
	return 0;
}

function buildRateWindowFromDetail(detail: Record<string, unknown>, label: string): RateWindow | undefined {
	const used = toNumber(detail.used);
	const limitVal = toNumber(detail.limit);
	const remaining = toNumber(detail.remaining);
	const usedPercent = computeUsedPercent(used, limitVal, remaining);
	const resetAt = findResetDate(detail);

	return {
		label,
		usedPercent,
		resetDescription: resetAt ? formatReset(resetAt) : undefined,
		resetAt: resetAt?.toISOString(),
	};
}

function buildLimitLabel(limit: KimiLimit): string | undefined {
	const duration = limit.window?.duration;
	const timeUnit = limit.window?.timeUnit;
	if (duration === undefined || !timeUnit) return undefined;

	const upper = timeUnit.toUpperCase();
	if (upper.includes("MINUTE") && duration === 300) return "5h";
	if (upper.includes("HOUR")) return `${duration}h`;
	if (upper.includes("DAY")) return `${duration}d`;
	if (upper.includes("MINUTE")) return `${duration}m`;
	if (upper.includes("WEEK")) return `${duration}w`;
	return `${duration} ${timeUnit}`;
}

export class KimiCodingProvider extends BaseProvider {
	readonly name = "kimi-coding" as const;
	readonly displayName = "Kimi Code Plan";

	hasCredentials(deps: Dependencies): boolean {
		return Boolean(loadKimiCodingApiKey(deps));
	}

	async fetchUsage(deps: Dependencies): Promise<UsageSnapshot> {
		const apiKey = loadKimiCodingApiKey(deps);
		if (!apiKey) {
			return this.emptySnapshot(noCredentials());
		}

		const { controller, clear } = createTimeoutController(API_TIMEOUT_MS);

		try {
			const res = await deps.fetch("https://api.kimi.com/coding/v1/usages", {
				method: "GET",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					Accept: "application/json",
				},
				signal: controller.signal,
			});
			clear();

			if (!res.ok) {
				return this.emptySnapshot(httpError(res.status));
			}

			const data = (await res.json()) as KimiUsageResponse;
			const windows: RateWindow[] = [];

			// Parse limits array → 5h rolling window(s)
			if (Array.isArray(data.limits)) {
				for (const limit of data.limits) {
					if (!limit.detail) continue;
					const label = buildLimitLabel(limit);
					if (!label) continue;
					const window = buildRateWindowFromDetail(limit.detail, label);
					if (window) windows.push(window);
				}
			}

			// Parse top-level usage → weekly quota
			if (data.usage) {
				const window = buildRateWindowFromDetail(data.usage, "Week");
				if (window) windows.push(window);
			}

			return this.snapshot({ windows });
		} catch {
			clear();
			return this.emptySnapshot(fetchFailed());
		}
	}
}
