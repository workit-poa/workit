export type CampaignStatusCode = 0 | 1 | 2 | 3;

export type CampaignStatusLabel = "Pending" | "Funding" | "Failed" | "Success";

export interface LaunchpadTokenView {
  address: string;
  symbol: string;
  decimals: number;
  isWorkToken: boolean;
}

export interface LaunchpadCampaignView {
  campaignAddress: string;
  status: CampaignStatusCode;
  statusLabel: CampaignStatusLabel;
  deadlineUnix: number;
  isParticipatable: boolean;
  goal: string;
  fundingSupply: string;
  campaignSupply: string;
  fundingToken: LaunchpadTokenView;
  campaignToken: LaunchpadTokenView;
}

export interface SponsoredTxResult {
  type: "wrap_hbar" | "approve" | "contribute";
  transactionId: string;
  mirrorLink: string;
}

export interface ParticipateCampaignResult {
  campaignAddress: string;
  participantEvmAddress: string;
  amount: string;
  amountRaw: string;
  fundingToken: string;
  transactions: SponsoredTxResult[];
}
