import { expect } from "chai";
import { ethers, network } from "hardhat";
import { type RevertDecodingInterface } from "../scripts/utils/contract-error-decoder";
import {
    loadDecodeInterfaces,
    readDeployment,
    resolveWorkDeployment,
    runTx,
} from "./utils/hederaTestnet";

const FACTORY_ABI = [
    "function pairCreateFee() external view returns (uint256)",
];
const EXCHANGE_RATE_PRECOMPILE = ethers.getAddress(
    "0x0000000000000000000000000000000000000168",
);
const EXCHANGE_RATE_ABI = [
    "function tinycentsToTinybars(uint256 tinycents) external returns (uint256)",
];

describe("Campaign + SaucerSwap integration (live Hedera testnet, deployed contracts)", function () {
    this.timeout(10 * 60 * 1000);
    let decodeInterfaces: RevertDecodingInterface[] = [];

    before(async function () {
        if (network.name !== "hederaTestnet") {
            this.skip();
        }
        decodeInterfaces = await loadDecodeInterfaces();
    });

    async function waitUntilAfter(deadline: bigint) {
        while (true) {
            const latest = await ethers.provider.getBlock("latest");
            const now = BigInt(
                latest?.timestamp ?? Math.floor(Date.now() / 1000),
            );
            if (now > deadline) return;
            await new Promise((resolveSleep) =>
                setTimeout(resolveSleep, 5_000),
            );
        }
    }

    async function resolvePairCreateFeeWei(
        owner: any,
        launchpad: any,
    ): Promise<bigint> {
        const factoryAddress = ethers.getAddress(await launchpad.factory());
        const factory = new ethers.Contract(factoryAddress, FACTORY_ABI, owner);
        const pairCreateFeeTinycent = BigInt(await factory.pairCreateFee());
        if (pairCreateFeeTinycent <= 0n) return 0n;

        const exchangeRate = new ethers.Contract(
            EXCHANGE_RATE_PRECOMPILE,
            EXCHANGE_RATE_ABI,
            owner,
        );
        const tinybars = BigInt(
            await exchangeRate.tinycentsToTinybars.staticCall(
                pairCreateFeeTinycent,
            ),
        );
        const dynamicWei = tinybars * 10n ** 10n;
        const safetyFloorWei = ethers.parseEther("15");
        return dynamicWei > safetyFloorWei ? dynamicWei : safetyFloorWei;
    }

    it("uses deploy.ts deployments: contribute, wait/end, resolve, then redeem or refund", async function () {
        const [owner] = await ethers.getSigners();

        const launchpadDeployment = await readDeployment("Launchpad");
        const campaignDeployment = await readDeployment("Campaign");
        const workDeployment = await resolveWorkDeployment();

        const launchpad = new ethers.Contract(
            launchpadDeployment.address,
            launchpadDeployment.abi,
            owner,
        );
        const campaign = await ethers.getContractAt(
            "Campaign",
            "0x311794b1940AA4c5F9dF1a77c2d581CD8997467b",
            owner,
        );
        const campaignAddress = await campaign.getAddress();
        const work = new ethers.Contract(
            workDeployment.address,
            workDeployment.abi,
            owner,
        );

        expect(await launchpad.owner()).to.equal(
            owner.address,
            "Signer must be launchpad owner for resolve operations",
        );
        expect(await campaign.owner()).to.equal(
            owner.address,
            "Signer must own deployed campaign",
        );

        const wrkTokenAddress = ethers.getAddress(await work.token());
        const campaignId = BigInt(
            ethers.solidityPackedKeccak256(["address"], [campaignAddress]),
        );

        let status = BigInt(await campaign.status());
        const listing = await campaign.listing();
        const deadline = BigInt(listing.deadline);
        const now = BigInt(
            (await ethers.provider.getBlock("latest"))?.timestamp ??
                Math.floor(Date.now() / 1000),
        );

        if (status === 0n) {
            await runTx(
                "Campaign.resolveCampaign (Pending->Funding)",
                txOverrides =>
                    campaign.resolveCampaign(ethers.ZeroAddress, txOverrides),
                decodeInterfaces,
                () => campaign.resolveCampaign.estimateGas(ethers.ZeroAddress),
            );
            status = BigInt(await campaign.status());
        }

        if (status === 1n && now < deadline) {
            await runTx(
                "Campaign.contributeHbar",
                txOverrides =>
                    campaign.contributeHbar(owner.address, {
                        value: ethers.parseEther("1"),
                        ...txOverrides,
                    }),
                decodeInterfaces,
                () =>
                    campaign.contributeHbar.estimateGas(owner.address, {
                        value: ethers.parseEther("1"),
                    }),
            );
            await waitUntilAfter(deadline);
            status = BigInt(await campaign.status());
        }

        if (status === 1n) {
            const resolveValue = await resolvePairCreateFeeWei(
                owner,
                launchpad,
            );
            await runTx(
                "Launchpad.deployPair",
                txOverrides =>
                    launchpad.deployPair(campaignAddress, {
                        value: resolveValue,
                        ...txOverrides,
                    }),
                decodeInterfaces,
                () =>
                    launchpad.deployPair.estimateGas(campaignAddress, {
                        value: resolveValue,
                    }),
            );

            await runTx(
                "Campaign.resolveCampaign",
                txOverrides =>
                    campaign.resolveCampaign(owner.address, txOverrides),
                decodeInterfaces,
                () => campaign.resolveCampaign.estimateGas(owner.address),
            );
            status = BigInt(await campaign.status());
        }

        const claimBalanceBefore = BigInt(
            await launchpad.balanceOf(owner.address, campaignId),
        );
        if (claimBalanceBefore > 0n && status === 3n) {
            await runTx(
                "Campaign.redeemContribution",
                txOverrides =>
                    campaign.redeemContribution(
                        claimBalanceBefore,
                        owner.address,
                        txOverrides,
                    ),
                decodeInterfaces,
                () =>
                    campaign.redeemContribution.estimateGas(
                        claimBalanceBefore,
                        owner.address,
                    ),
            );
            expect(
                await launchpad.balanceOf(owner.address, campaignId),
            ).to.equal(0n);
        } else if (claimBalanceBefore > 0n && status === 2n) {
            await runTx(
                "Campaign.refundContribution",
                txOverrides =>
                    campaign.refundContribution(
                        claimBalanceBefore,
                        owner.address,
                        txOverrides,
                    ),
                decodeInterfaces,
                () =>
                    campaign.refundContribution.estimateGas(
                        claimBalanceBefore,
                        owner.address,
                    ),
            );
            expect(
                await launchpad.balanceOf(owner.address, campaignId),
            ).to.equal(0n);
        }

        expect([2n, 3n]).to.include(status);
        expect(
            await campaign
                .listing()
                .then((l: any) => ethers.getAddress(l.campaignToken)),
        ).to.equal(wrkTokenAddress);
    });
});
