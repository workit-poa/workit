import { ethers } from "hardhat";

export type RevertDecodingInterface = {
	parseError: (
		data: string,
	) => { name: string; args: readonly unknown[] } | null;
};

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function extractRevertData(error: unknown): string | null {
	const visited = new Set<unknown>();
	const stack: unknown[] = [error];

	while (stack.length > 0) {
		const value = stack.pop();
		if (!value || typeof value !== "object" || visited.has(value)) continue;
		visited.add(value);

		const record = value as Record<string, unknown>;
		const directData = record.data;
		if (
			typeof directData === "string" &&
			directData.startsWith("0x") &&
			directData.length >= 10
		) {
			return directData;
		}

		for (const key of ["error", "info", "cause"]) {
			if (record[key] !== undefined) {
				stack.push(record[key]);
			}
		}
	}

	return null;
}

export function decodeRevertData(
	data: string,
	contractInterface?: RevertDecodingInterface,
): string {
	if (!data || data === "0x") {
		return "empty revert data";
	}

	if (contractInterface) {
		try {
			const parsed = contractInterface.parseError(data);
			if (parsed) {
				const args = parsed.args
					.map((arg: unknown) =>
						typeof arg === "bigint" ? arg.toString() : String(arg),
					)
					.join(", ");
				return `${parsed.name}(${args})`;
			}
		} catch {
			// Continue to generic decoders.
		}
	}

	const selector = data.slice(0, 10).toLowerCase();
	try {
		if (selector === "0x08c379a0") {
			const [reason] = ethers.AbiCoder.defaultAbiCoder().decode(
				["string"],
				`0x${data.slice(10)}`,
			);
			return `Error(${String(reason)})`;
		}
		if (selector === "0x4e487b71") {
			const [code] = ethers.AbiCoder.defaultAbiCoder().decode(
				["uint256"],
				`0x${data.slice(10)}`,
			);
			return `Panic(${code.toString()})`;
		}
	} catch {
		// Fall through to raw data.
	}

	return `raw revert data: ${data}`;
}

export function formatDecodedRevert(
	action: string,
	error: unknown,
	contractInterface?: RevertDecodingInterface,
): Error {
	const revertData = extractRevertData(error);
	const decoded = revertData
		? decodeRevertData(revertData, contractInterface)
		: "no revert data found";
	return new Error(
		`${action} failed: ${decoded}. Original error: ${toErrorMessage(error)}`,
	);
}
