import { TopicCreateTransaction, TopicMessageSubmitTransaction } from "@hashgraph/sdk";
import { createHederaLocalClient } from "./hedera-local-client";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForMirrorMessage(
  mirrorRestBaseUrl: string,
  topicId: string,
  timeoutMs: number,
): Promise<{ sequenceNumber: string; message: string } | null> {
  const startedAt = Date.now();
  const endpoint = `${mirrorRestBaseUrl}/api/v1/topics/${topicId}/messages?limit=1&order=desc`;

  while (Date.now() - startedAt < timeoutMs) {
    const response = await fetch(endpoint);
    if (response.ok) {
      const payload = (await response.json()) as { messages?: Array<{ sequence_number: string; message: string }> };
      const latest = payload.messages?.[0];
      if (latest?.message) {
        return {
          sequenceNumber: latest.sequence_number,
          message: Buffer.from(latest.message, "base64").toString("utf8"),
        };
      }
    }

    await sleep(1000);
  }

  return null;
}

async function main() {
  const { client, config, operator } = createHederaLocalClient();
  const message = process.env.HEDERA_LOCAL_HCS_MESSAGE || `workit-local-hcs ${new Date().toISOString()}`;

  console.log(`Using operator account: ${operator.accountIdRaw}`);
  console.log(`Consensus endpoint: ${config.consensusEndpoint}`);
  console.log(`Mirror REST endpoint: ${config.mirrorRestEndpoint}`);

  try {
    const topicCreateTx = new TopicCreateTransaction().setTopicMemo("workit-local-hcs");
    const topicCreateResponse = await topicCreateTx.execute(client);
    const topicCreateReceipt = await topicCreateResponse.getReceipt(client);
    const topicId = topicCreateReceipt.topicId;

    if (!topicId) {
      throw new Error("Topic creation receipt did not include topicId");
    }

    console.log(`Created topic: ${topicId.toString()}`);

    const submitTx = new TopicMessageSubmitTransaction().setTopicId(topicId).setMessage(message);
    const submitResponse = await submitTx.execute(client);
    await submitResponse.getReceipt(client);

    console.log(`Submitted message: ${message}`);

    const mirrorMessage = await waitForMirrorMessage(config.mirrorRestEndpoint, topicId.toString(), 15_000);
    if (mirrorMessage) {
      console.log(`Mirror indexed message #${mirrorMessage.sequenceNumber}: ${mirrorMessage.message}`);
    } else {
      console.log("Mirror indexing is delayed. Check mirror REST manually for topic messages.");
    }
  } finally {
    client.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
