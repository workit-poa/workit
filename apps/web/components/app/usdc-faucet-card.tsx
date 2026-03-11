"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";

type FaucetStatusResponse = {
  eligible: boolean;
  retryAfterSeconds: number;
  nextEligibleAt: string | null;
};

type FaucetClaimSuccessResponse = {
  status: "claimed";
  tokenSymbol: string;
  amount: string;
  recipient: string;
  transactionHash: string;
  explorerUrl: string | null;
  nextEligibleAt: string;
};

type FaucetClaimLimitedResponse = {
  status: "rate_limited";
  retryAfterSeconds: number;
  nextEligibleAt: string;
};

function toLocalDateTime(isoTimestamp: string | null): string {
  if (!isoTimestamp) return "Now";
  const value = new Date(isoTimestamp);
  if (Number.isNaN(value.getTime())) return "Unknown";
  return value.toLocaleString();
}

export function UsdcFaucetCard() {
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [claiming, setClaiming] = useState(false);
  const [status, setStatus] = useState<FaucetStatusResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<FaucetClaimSuccessResponse | null>(null);

  const fetchStatus = useCallback(async () => {
    setLoadingStatus(true);
    setError(null);

    try {
      const response = await fetch("/api/faucet/usdc", {
        method: "GET",
        cache: "no-store"
      });
      const payload = (await response.json()) as FaucetStatusResponse | { error?: string };
      if (!response.ok) {
        const message = "error" in payload && typeof payload.error === "string" ? payload.error : "Failed to load faucet status";
        throw new Error(message);
      }

      setStatus(payload as FaucetStatusResponse);
    } catch (statusError) {
      setError(statusError instanceof Error ? statusError.message : "Failed to load faucet status");
    } finally {
      setLoadingStatus(false);
    }
  }, []);

  useEffect(() => {
    void fetchStatus();
  }, [fetchStatus]);

  const claim = useCallback(async () => {
    setClaiming(true);
    setError(null);

    try {
      const response = await fetch("/api/faucet/usdc", {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        }
      });

      const payload = (await response.json()) as FaucetClaimSuccessResponse | FaucetClaimLimitedResponse | { error?: string };
      if (!response.ok && response.status !== 429) {
        const message = "error" in payload && typeof payload.error === "string" ? payload.error : "Faucet claim failed";
        throw new Error(message);
      }

      if ("status" in payload && payload.status === "rate_limited") {
        setStatus({
          eligible: false,
          retryAfterSeconds: payload.retryAfterSeconds,
          nextEligibleAt: payload.nextEligibleAt
        });
        setSuccess(null);
        return;
      }

      const claimSuccess = payload as FaucetClaimSuccessResponse;
      setSuccess(claimSuccess);
      setStatus({
        eligible: false,
        retryAfterSeconds: Math.max(0, Math.ceil((new Date(claimSuccess.nextEligibleAt).getTime() - Date.now()) / 1000)),
        nextEligibleAt: claimSuccess.nextEligibleAt
      });
    } catch (claimError) {
      setError(claimError instanceof Error ? claimError.message : "Faucet claim failed");
    } finally {
      setClaiming(false);
    }
  }, []);

  const claimDisabled = useMemo(() => {
    if (claiming || loadingStatus) return true;
    return !status?.eligible;
  }, [claiming, loadingStatus, status]);

  return (
    <Card className="border-border/70 bg-card/90">
      <CardHeader>
        <CardTitle className="text-lg">USDC Faucet</CardTitle>
        <CardDescription>Claim 1 USDC every 24 hours. The operator swaps HBAR to USDC and sends it to your KMS wallet.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3 text-sm">
        {loadingStatus && (
          <div className="inline-flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading faucet status...
          </div>
        )}

        {!loadingStatus && status?.eligible && <p className="text-muted-foreground">You are eligible to claim now.</p>}

        {!loadingStatus && status && !status.eligible && (
          <p className="text-muted-foreground">Next claim available at {toLocalDateTime(status.nextEligibleAt)}.</p>
        )}

        <Button onClick={() => void claim()} disabled={claimDisabled}>
          {claiming ? "Claiming..." : "Claim 1 USDC"}
        </Button>

        {success && (
          <Alert>
            <AlertTitle>USDC sent</AlertTitle>
            <AlertDescription>
              <p>
                {success.amount} {success.tokenSymbol} sent to {success.recipient}
              </p>
              <p>
                Transaction:{" "}
                {success.explorerUrl ? (
                  <a href={success.explorerUrl} target="_blank" rel="noreferrer" className="underline underline-offset-4">
                    {success.transactionHash}
                  </a>
                ) : (
                  success.transactionHash
                )}
              </p>
            </AlertDescription>
          </Alert>
        )}

        {error && (
          <Alert variant="destructive">
            <AlertTitle>Faucet error</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
      </CardContent>
    </Card>
  );
}
