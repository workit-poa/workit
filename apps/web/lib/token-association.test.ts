import assert from "node:assert/strict";
import test from "node:test";

import {
	resolveAddressFromTokenId,
	resolveTokenIdFromAddress,
} from "./hedera/token-association";

test("resolveTokenIdFromAddress resolves a Hedera token EVM address", () => {
	const tokenId = resolveTokenIdFromAddress(
		"0x0000000000000000000000000000000000003ad1",
	);
	assert.equal(tokenId, "0.0.15057");
});

test("resolveTokenIdFromAddress returns null for invalid addresses", () => {
	assert.equal(resolveTokenIdFromAddress("not-an-address"), null);
});

test("resolveAddressFromTokenId resolves back to canonical EVM address", () => {
	const address = resolveAddressFromTokenId("0.0.15057");
	assert.equal(address, "0x0000000000000000000000000000000000003ad1");
});
