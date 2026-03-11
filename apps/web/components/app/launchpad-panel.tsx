"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { Loader2 } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../ui/card";
import { Input } from "../ui/input";
import type { LaunchpadCampaignView, SponsoredTxResult } from "../../lib/launchpad/types";

type CampaignsResponse = {
  campaigns: LaunchpadCampaignView[];
};

function formatTokenAmount(valueRaw: string, decimals: number, maxFractionDigits = 4): string {
  const value = BigInt(valueRaw);
  if (value === 0n) return "0";

  const base = 10n ** BigInt(decimals);
  const whole = value / base;
  const remainder = value % base;
  if (remainder === 0n) return whole.toString();

  let fraction = remainder.toString().padStart(decimals, "0").replace(/0+$/, "");
  if (fraction.length > maxFractionDigits) {
    fraction = fraction.slice(0, maxFractionDigits);
  }
  return `${whole.toString()}.${fraction}`;
}

function formatDeadline(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toLocaleString();
}

function toProgressPercent(fundingSupplyRaw: string, goalRaw: string): number {
  const goal = BigInt(goalRaw);
  if (goal === 0n) return 0;

  const funded = BigInt(fundingSupplyRaw);
  const basisPoints = Number((funded * 10_000n) / goal);
  return Math.min(100, basisPoints / 100);
}

export function LaunchpadPanel() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [campaigns, setCampaigns] = useState<LaunchpadCampaignView[]>([]);
  const [amountByCampaign, setAmountByCampaign] = useState<Record<string, string>>({});
  const [submittingCampaign, setSubmittingCampaign] = useState<string | null>(null);
  const [actionErrors, setActionErrors] = useState<Record<string, string>>({});
  const [txByCampaign, setTxByCampaign] = useState<Record<string, SponsoredTxResult[]>>({});

  const fetchCampaigns = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const response = await fetch("/api/launchpad/campaigns", {
        method: "GET",
        cache: "no-store"
      });
      const payload = (await response.json()) as CampaignsResponse | { error?: string };
      if (!response.ok) {
        const errorMessage = "error" in payload && typeof payload.error === "string" ? payload.error : "Failed to fetch campaigns";
        throw new Error(errorMessage);
      }

      setCampaigns("campaigns" in payload && Array.isArray(payload.campaigns) ? payload.campaigns : []);
    } catch (fetchError) {
      setError(fetchError instanceof Error ? fetchError.message : "Failed to fetch campaigns");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchCampaigns();
  }, [fetchCampaigns]);

  const availableCampaigns = useMemo(() => campaigns.filter(campaign => campaign.isParticipatable), [campaigns]);

  const participate = useCallback(
    async (campaign: LaunchpadCampaignView) => {
      const amount = (amountByCampaign[campaign.campaignAddress] || "").trim();
      if (!amount) {
        setActionErrors(prev => ({
          ...prev,
          [campaign.campaignAddress]: "Enter a contribution amount first."
        }));
        return;
      }

      setSubmittingCampaign(campaign.campaignAddress);
      setActionErrors(prev => ({
        ...prev,
        [campaign.campaignAddress]: ""
      }));

      try {
        const response = await fetch(`/api/launchpad/campaigns/${campaign.campaignAddress}/participate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ amount })
        });
        const payload = (await response.json()) as { transactions?: SponsoredTxResult[]; error?: string };
        if (!response.ok) {
          throw new Error(typeof payload.error === "string" ? payload.error : "Failed to submit participation");
        }

        setTxByCampaign(prev => ({
          ...prev,
          [campaign.campaignAddress]: payload.transactions ?? []
        }));

        setAmountByCampaign(prev => ({
          ...prev,
          [campaign.campaignAddress]: ""
        }));

        await fetchCampaigns();
      } catch (participationError) {
        setActionErrors(prev => ({
          ...prev,
          [campaign.campaignAddress]:
            participationError instanceof Error ? participationError.message : "Failed to submit participation"
        }));
      } finally {
        setSubmittingCampaign(null);
      }
    },
    [amountByCampaign, fetchCampaigns]
  );

  return (
    <Card className="border-border/70 bg-card/90">
      <CardHeader>
        <CardTitle className="text-xl">WRK Launchpad Campaigns</CardTitle>
        <CardDescription>
          Contributions are submitted with sponsored gas. The paymaster covers network fees for launchpad transactions.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {loading && (
          <div className="inline-flex items-center gap-2 rounded-md border border-border/70 px-3 py-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
            Loading campaigns...
          </div>
        )}

        {!loading && error && (
          <Alert variant="destructive">
            <AlertTitle>Unable to load campaigns</AlertTitle>
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}

        {!loading && !error && availableCampaigns.length === 0 && (
          <Alert>
            <AlertTitle>No active campaigns</AlertTitle>
            <AlertDescription>No WRK launchpad campaign is currently open for contributions.</AlertDescription>
          </Alert>
        )}

        {!loading &&
          !error &&
          availableCampaigns.map(campaign => {
            const progress = toProgressPercent(campaign.fundingSupply, campaign.goal);
            const txResults = txByCampaign[campaign.campaignAddress] || [];

            return (
              <article key={campaign.campaignAddress} className="space-y-3 rounded-lg border border-border/70 bg-background/70 p-4">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <h3 className="text-base font-semibold">
                    {campaign.fundingToken.symbol}/{campaign.campaignToken.symbol}
                  </h3>
                  <p className="text-xs text-muted-foreground">Deadline: {formatDeadline(campaign.deadlineUnix)}</p>
                </div>

                <div className="grid gap-2 text-sm text-muted-foreground sm:grid-cols-2">
                  <p>
                    Funding: {formatTokenAmount(campaign.fundingSupply, campaign.fundingToken.decimals)}{" "}
                    {campaign.fundingToken.symbol}
                  </p>
                  <p>
                    Goal: {formatTokenAmount(campaign.goal, campaign.fundingToken.decimals)} {campaign.fundingToken.symbol}
                  </p>
                  <p>Status: {campaign.statusLabel}</p>
                  <p>Campaign contract: {campaign.campaignAddress}</p>
                </div>

                <div className="h-2 overflow-hidden rounded-full bg-muted">
                  <div className="h-full bg-primary transition-all" style={{ width: `${progress}%` }} />
                </div>

                <div className="flex flex-col gap-2 sm:flex-row">
                  <Input
                    type="text"
                    inputMode="decimal"
                    placeholder={`Amount in ${campaign.fundingToken.symbol}`}
                    value={amountByCampaign[campaign.campaignAddress] || ""}
                    onChange={event =>
                      setAmountByCampaign(prev => ({
                        ...prev,
                        [campaign.campaignAddress]: event.target.value
                      }))
                    }
                    disabled={submittingCampaign === campaign.campaignAddress}
                  />
                  <Button
                    onClick={() => void participate(campaign)}
                    disabled={submittingCampaign === campaign.campaignAddress}
                  >
                    {submittingCampaign === campaign.campaignAddress ? "Submitting..." : "Participate"}
                  </Button>
                </div>

                {actionErrors[campaign.campaignAddress] && (
                  <p className="text-sm text-destructive">{actionErrors[campaign.campaignAddress]}</p>
                )}

                {txResults.length > 0 && (
                  <div className="space-y-1 text-sm">
                    <p className="font-medium">Last sponsored transaction(s):</p>
                    {txResults.map(result => (
                      <p key={`${result.type}-${result.transactionId}`} className="text-muted-foreground">
                        {result.type}:{" "}
                        <a
                          href={result.mirrorLink}
                          className="text-foreground underline underline-offset-4"
                          rel="noreferrer"
                          target="_blank"
                        >
                          {result.transactionId}
                        </a>
                      </p>
                    ))}
                  </div>
                )}
              </article>
            );
          })}
      </CardContent>
    </Card>
  );
}
