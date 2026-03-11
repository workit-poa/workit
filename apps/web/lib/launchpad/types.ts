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

export type ContributionUiStage =
  | "idle"
  | "checking_balances"
  | "awaiting_confirmation"
  | "wrapping_hbar"
  | "approving_whbar"
  | "contributing";

export interface CampaignContributionPreview {
  campaignAddress: string;
  fundingToken: string;
  amount: string;
  amountRaw: string;
  fundingTokenDecimals: number;
  usesWhbarFunding: boolean;
  whbarBalanceRaw: string;
  nativeHbarBalanceRaw: string;
  nativeHbarReserveRaw: string;
  wrapAmountRaw: string;
  approvalRequired: boolean;
  allowanceRaw: string;
}

export interface ParticipateCampaignResult {
  preview: CampaignContributionPreview;
  campaignAddress: string;
  participantEvmAddress: string;
  amount: string;
  amountRaw: string;
  fundingToken: string;
  transactions: SponsoredTxResult[];
}
