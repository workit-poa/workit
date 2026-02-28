import express from "express";
import { createSessionPayload } from "@workit/auth";
import { createWalletService } from "@workit/wallet";

const app = express();
const port = Number(process.env.PORT || 3000);
const walletService = createWalletService();

app.get("/health", (_req, res) => {
  res.json({ ok: true });
});

app.get("/session/:userId", (req, res) => {
  const session = createSessionPayload(req.params.userId);
  res.json(session);
});

app.get("/wallet/:accountId", async (req, res) => {
  const details = await walletService.getWalletDetails(req.params.accountId);
  res.json(details);
});

app.listen(port, () => {
  console.log(`Backend running on http://localhost:${port}`);
});

