import {
  AccountBalanceQuery,
  TokenAssociateTransaction,
  TokenCreateTransaction,
  TransferTransaction,
} from "@hashgraph/sdk";
import { createHederaLocalClient, getSecondaryLocalAccount } from "./hedera-local-client";

function parsePositiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return parsed;
}

function parseNonNegativeInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;

  const parsed = Number.parseInt(raw, 10);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return parsed;
}

async function main() {
  const { client, operator } = createHederaLocalClient();
  const recipient = getSecondaryLocalAccount();

  const tokenName = process.env.HEDERA_LOCAL_HTS_NAME || `Workit Local Token ${Date.now()}`;
  const tokenSymbol = process.env.HEDERA_LOCAL_HTS_SYMBOL || "WLT";
  const decimals = parseNonNegativeInt("HEDERA_LOCAL_HTS_DECIMALS", 2);
  const initialSupply = parsePositiveInt("HEDERA_LOCAL_HTS_INITIAL_SUPPLY", 1_000);
  const transferAmount = parsePositiveInt("HEDERA_LOCAL_HTS_TRANSFER_UNITS", 25);

  console.log(`Treasury/operator: ${operator.accountIdRaw}`);
  console.log(`Recipient: ${recipient.accountIdRaw}`);

  try {
    const tokenCreateTx = new TokenCreateTransaction()
      .setTokenName(tokenName)
      .setTokenSymbol(tokenSymbol)
      .setDecimals(decimals)
      .setInitialSupply(initialSupply)
      .setTreasuryAccountId(operator.accountId)
      .setAdminKey(operator.privateKey.publicKey)
      .setSupplyKey(operator.privateKey.publicKey)
      .setTokenMemo("workit-local-hts");

    const tokenCreateResponse = await tokenCreateTx.execute(client);
    const tokenCreateReceipt = await tokenCreateResponse.getReceipt(client);
    const tokenId = tokenCreateReceipt.tokenId;

    if (!tokenId) {
      throw new Error("Token creation receipt did not include tokenId");
    }

    console.log(`Created token: ${tokenId.toString()}`);

    let associateTx = await new TokenAssociateTransaction()
      .setAccountId(recipient.accountId)
      .setTokenIds([tokenId])
      .freezeWith(client);
    associateTx = await associateTx.sign(recipient.privateKey);

    const associateResponse = await associateTx.execute(client);
    await associateResponse.getReceipt(client);
    console.log(`Associated token ${tokenId.toString()} to ${recipient.accountIdRaw}`);

    const transferTx = new TransferTransaction()
      .addTokenTransfer(tokenId, operator.accountId, -transferAmount)
      .addTokenTransfer(tokenId, recipient.accountId, transferAmount);

    const transferResponse = await transferTx.execute(client);
    await transferResponse.getReceipt(client);
    console.log(`Transferred ${transferAmount} ${tokenSymbol} to ${recipient.accountIdRaw}`);

    const treasuryBalance = await new AccountBalanceQuery().setAccountId(operator.accountId).execute(client);
    const recipientBalance = await new AccountBalanceQuery().setAccountId(recipient.accountId).execute(client);

    const treasuryTokenBalance = treasuryBalance.tokens?.get(tokenId)?.toString() ?? "0";
    const recipientTokenBalance = recipientBalance.tokens?.get(tokenId)?.toString() ?? "0";

    console.log(`Treasury balance for ${tokenId.toString()}: ${treasuryTokenBalance}`);
    console.log(`Recipient balance for ${tokenId.toString()}: ${recipientTokenBalance}`);
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
