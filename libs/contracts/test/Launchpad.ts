import { expect } from "chai";
import { ethers, network } from "hardhat";
import { type RevertDecodingInterface } from "../scripts/utils/contract-error-decoder";
import {
    loadDecodeInterfaces,
    readDeployment,
    resolveWorkDeployment,
    runTx,
} from "./utils/hederaTestnet";

function isOpaqueHederaRevert(error: unknown): boolean {
    if (!(error instanceof Error)) return false;
    return (
        error.message.includes("no revert data found") ||
        error.message.includes("CONTRACT_REVERT_EXECUTED")
    );
}

describe("Launchpad", function () {
    let decodeInterfaces: RevertDecodingInterface[] = [];

    before(async function () {
        if (network.name === "hederaTestnet") {
            decodeInterfaces = await loadDecodeInterfaces();
        }
    });

    async function deployFixture() {
        const [owner] = await ethers.getSigners();

        const factoryFactory = await ethers.getContractFactory(
            "MockUniswapV2Factory",
        );
        const uniswapFactory = (await factoryFactory.deploy()) as any;
        await uniswapFactory.waitForDeployment();

        const tokenFactory = await ethers.getContractFactory("MockERC20");
        const workToken = (await tokenFactory.deploy("Work", "WRK")) as any;
        await workToken.waitForDeployment();

        const stakingFactory = await ethers.getContractFactory(
            "MockStakingForLaunchpad",
        );
        const staking = (await stakingFactory.deploy(
            await workToken.getAddress(),
        )) as any;
        await staking.waitForDeployment();

        const campaignFactory = await ethers.getContractFactory("Campaign");
        const campaignImplementation = (await campaignFactory.deploy()) as any;
        await campaignImplementation.waitForDeployment();

        const beaconFactory = await ethers.getContractFactory(
            "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
        );
        const campaignBeacon = (await beaconFactory.deploy(
            await campaignImplementation.getAddress(),
            owner.address,
        )) as any;
        await campaignBeacon.waitForDeployment();

        const launchpadImplFactory =
            await ethers.getContractFactory("Launchpad");
        const launchpadImplementation =
            (await launchpadImplFactory.deploy()) as any;
        await launchpadImplementation.waitForDeployment();

        const initData = launchpadImplFactory.interface.encodeFunctionData(
            "initialize",
            [
                await uniswapFactory.getAddress(),
                owner.address,
                await staking.getAddress(),
                await campaignBeacon.getAddress(),
                owner.address,
            ],
        );
        const proxyFactory = await ethers.getContractFactory(
            "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
        );
        const launchpadProxy = (await proxyFactory.deploy(
            await launchpadImplementation.getAddress(),
            initData,
        )) as any;
        await launchpadProxy.waitForDeployment();
        const launchpad = launchpadImplFactory.attach(
            await launchpadProxy.getAddress(),
        ) as any;

        return { owner, uniswapFactory, workToken, staking, launchpad };
    }

    async function buildValidListing(
        workTokenAddress: string,
        campaignTokenAddress: string,
    ) {
        const latest = await ethers.provider.getBlock("latest");
        const now = latest?.timestamp ?? Math.floor(Date.now() / 1000);
        return {
            campaignToken: campaignTokenAddress,
            fundingToken: workTokenAddress,
            lockEpochs: 180n,
            goal: 1_000n,
            deadline: BigInt(now + 3600),
        };
    }

    it("deploys and wires constructor state", async function () {
        const { owner, uniswapFactory, workToken, staking, launchpad } =
            await deployFixture();

        expect(await launchpad.owner()).to.equal(owner.address);
        expect(await launchpad.factory()).to.equal(
            await uniswapFactory.getAddress(),
        );
        expect(await launchpad.workToken()).to.equal(
            await workToken.getAddress(),
        );
        expect(await launchpad.campaignPair(owner.address)).to.equal(
            ethers.ZeroAddress,
        );

        expect(await staking.workToken()).to.equal(
            await workToken.getAddress(),
        );
    });

    it("reverts on zero-address constructor args", async function () {
        const [owner] = await ethers.getSigners();
        const launchpadFactory = await ethers.getContractFactory("Launchpad");
        const campaignFactory = await ethers.getContractFactory("Campaign");
        const campaignImplementation = (await campaignFactory.deploy()) as any;
        await campaignImplementation.waitForDeployment();
        const beaconFactory = await ethers.getContractFactory(
            "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
        );
        const campaignBeacon = (await beaconFactory.deploy(
            await campaignImplementation.getAddress(),
            owner.address,
        )) as any;
        await campaignBeacon.waitForDeployment();
        const launchpadImplementation =
            (await launchpadFactory.deploy()) as any;
        await launchpadImplementation.waitForDeployment();
        const proxyFactory = await ethers.getContractFactory(
            "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
        );

        await expect(
            proxyFactory.deploy(
                await launchpadImplementation.getAddress(),
                launchpadFactory.interface.encodeFunctionData("initialize", [
                    ethers.ZeroAddress,
                    owner.address,
                    owner.address,
                    await campaignBeacon.getAddress(),
                    owner.address,
                ]),
            ),
        )
            .to.be.revertedWithCustomError(
                launchpadImplementation,
                "InvalidAddress",
            )
            .withArgs(ethers.ZeroAddress);

        await expect(
            proxyFactory.deploy(
                await launchpadImplementation.getAddress(),
                launchpadFactory.interface.encodeFunctionData("initialize", [
                    owner.address,
                    ethers.ZeroAddress,
                    owner.address,
                    await campaignBeacon.getAddress(),
                    owner.address,
                ]),
            ),
        )
            .to.be.revertedWithCustomError(
                launchpadImplementation,
                "InvalidAddress",
            )
            .withArgs(ethers.ZeroAddress);

        await expect(
            proxyFactory.deploy(
                await launchpadImplementation.getAddress(),
                launchpadFactory.interface.encodeFunctionData("initialize", [
                    owner.address,
                    owner.address,
                    ethers.ZeroAddress,
                    await campaignBeacon.getAddress(),
                    owner.address,
                ]),
            ),
        )
            .to.be.revertedWithCustomError(
                launchpadImplementation,
                "InvalidAddress",
            )
            .withArgs(ethers.ZeroAddress);

        await expect(
            proxyFactory.deploy(
                await launchpadImplementation.getAddress(),
                launchpadFactory.interface.encodeFunctionData("initialize", [
                    owner.address,
                    owner.address,
                    owner.address,
                    ethers.ZeroAddress,
                    owner.address,
                ]),
            ),
        )
            .to.be.revertedWithCustomError(
                launchpadImplementation,
                "InvalidAddress",
            )
            .withArgs(ethers.ZeroAddress);
    });

    it("returns false when token does not implement HRC-719 associate()", async function () {
        const { launchpad, workToken } = await deployFixture();

        await expect(launchpad.associateTokenIfNeeded(ethers.ZeroAddress))
            .to.be.revertedWithCustomError(launchpad, "InvalidAddress")
            .withArgs(ethers.ZeroAddress);

        expect(
            await launchpad.associateTokenIfNeeded.staticCall(
                await workToken.getAddress(),
            ),
        ).to.equal(false);
        await expect(
            launchpad.associateTokenIfNeeded(await workToken.getAddress()),
        ).to.not.be.reverted;
    });

    it("supports owner-managed batch association planning", async function () {
        const { owner, launchpad, workToken } = await deployFixture();
        const [_, other] = await ethers.getSigners();

        await expect(
            launchpad
                .connect(other)
                .associateTokensIfNeeded([await workToken.getAddress()]),
        ).to.be.revertedWithCustomError(
            launchpad,
            "OwnableUnauthorizedAccount",
        );

        const result = await launchpad.associateTokensIfNeeded.staticCall([
            await workToken.getAddress(),
        ]);
        expect(result[0]).to.equal(0n);
        expect(result[1]).to.equal(0n);
        expect(result[2]).to.equal(1n);

        await expect(
            launchpad
                .connect(owner)
                .associateTokensIfNeeded([await workToken.getAddress()]),
        ).to.not.be.reverted;

        await expect(launchpad.associateTokensIfNeeded([ethers.ZeroAddress]))
            .to.be.revertedWithCustomError(launchpad, "InvalidAddress")
            .withArgs(ethers.ZeroAddress);
    });

    it("creates a campaign and transitions it into funding", async function () {
        const { owner, launchpad, workToken } = await deployFixture();

        const tokenFactory = await ethers.getContractFactory("MockERC20");
        const campaignToken = (await tokenFactory.deploy(
            "Campaign",
            "CMP",
        )) as any;
        await campaignToken.waitForDeployment();

        const listing = await buildValidListing(
            await workToken.getAddress(),
            await campaignToken.getAddress(),
        );
        const campaignTokenSupply = 100_000n;

        await campaignToken.mint(owner.address, campaignTokenSupply);
        await campaignToken.approve(
            await launchpad.getAddress(),
            campaignTokenSupply,
        );

        await expect(launchpad.createCampaign(listing, campaignTokenSupply)).to
            .not.be.reverted;

        const campaignAddress = await launchpad.campaignByTokens(
            await workToken.getAddress(),
            await campaignToken.getAddress(),
        );
        expect(campaignAddress).to.not.equal(ethers.ZeroAddress);

        const campaign = await ethers.getContractAt(
            "Campaign",
            campaignAddress,
        );
        expect(await campaign.owner()).to.equal(owner.address);
        expect(await campaign.status()).to.equal(1n); // Funding
        expect(await campaign.campaignSupply()).to.equal(campaignTokenSupply);

        expect(
            await launchpad.campaignByTokens(
                await campaignToken.getAddress(),
                await workToken.getAddress(),
            ),
        ).to.equal(campaignAddress);
    });

    it("launches WRK/HBAR campaign with deploy-script parameters", async function () {
        this.timeout(10 * 60 * 1000);

        if (network.name !== "hederaTestnet") {
            this.skip();
        }

        const [owner] = await ethers.getSigners();
        const launchpadDeployment = await readDeployment("Launchpad");
        const stakingDeployment = await readDeployment("Staking");
        const workDeployment = await resolveWorkDeployment();

        const launchpad = await ethers.getContractAt(
            "Launchpad",
            launchpadDeployment.address,
            owner,
        );
        const staking = new ethers.Contract(
            stakingDeployment.address,
            stakingDeployment.abi,
            owner,
        );
        const work = new ethers.Contract(
            workDeployment.address,
            workDeployment.abi,
            owner,
        );

        const icoCampaignSupply = 734_999_999_775_143n;
        const icoLockEpochs = 180n;
        const icoGoal = 1n * 10n ** 8n;
        const icoDurationSeconds = 36_000;
        const wrkTokenAddress = ethers.getAddress(await work.token());
        const hbarTokenAddress = ethers.getAddress(await staking.whbarToken());
        const launchpadAddress = await launchpad.getAddress();
        const latest = await ethers.provider.getBlock("latest");
        const now = latest?.timestamp ?? Math.floor(Date.now() / 1000);
        const deadline = BigInt(now + icoDurationSeconds);
        const campaignToken = new ethers.Contract(
            wrkTokenAddress,
            [
                "function balanceOf(address account) view returns (uint256)",
                "function allowance(address owner, address spender) view returns (uint256)",
                "function approve(address spender, uint256 amount) returns (bool)",
            ],
            owner,
        );

        const allowance = BigInt(
            await campaignToken.allowance(owner.address, launchpadAddress),
        );
        if (allowance < icoCampaignSupply) {
            await runTx(
                "WRK.approve(Launchpad)",
                txOverrides =>
                    campaignToken.approve(
                        launchpadAddress,
                        icoCampaignSupply,
                        txOverrides,
                    ),
                decodeInterfaces,
                () =>
                    campaignToken.approve.estimateGas(
                        launchpadAddress,
                        icoCampaignSupply,
                    ),
            );
        }


        let campaignAddress = await launchpad.campaignByTokens(
            hbarTokenAddress,
            wrkTokenAddress,
        );
        // if (campaignAddress === ethers.ZeroAddress) {
            const factory = new ethers.Contract(
                await launchpad.factory(),
                ["function getPair(address,address) view returns (address)"],
                owner,
            );
            const existingPair = await factory.getPair(
                hbarTokenAddress,
                wrkTokenAddress,
            );
            if (existingPair !== ethers.ZeroAddress) {
                this.skip();
            }

                await runTx(
                    "Launchpad.createCampaign(WRK/HBAR)",
                    txOverrides =>
                        launchpad.createCampaign(
                            {
                                campaignToken: wrkTokenAddress,
                                fundingToken: hbarTokenAddress,
                                lockEpochs: icoLockEpochs,
                                goal: icoGoal,
                                deadline,
                            },
                            icoCampaignSupply,
                            txOverrides,
                        ),
                    decodeInterfaces,
                    () =>
                        launchpad.createCampaign.estimateGas(
                            {
                                campaignToken: wrkTokenAddress,
                                fundingToken: hbarTokenAddress,
                                lockEpochs: icoLockEpochs,
                                goal: icoGoal,
                                deadline,
                            },
                            icoCampaignSupply,
                        ),
                );
           

            campaignAddress = await launchpad.campaignByTokens(
                hbarTokenAddress,
                wrkTokenAddress,
            );
        // }

        console.log({campaignAddress})
        expect(campaignAddress).to.not.equal(ethers.ZeroAddress);

        const campaign = await ethers.getContractAt(
            "Campaign",
            campaignAddress,
        );
        const listing = await campaign.listing();

        expect(ethers.getAddress(listing.campaignToken)).to.equal(
            wrkTokenAddress,
        );
        expect(ethers.getAddress(listing.fundingToken)).to.equal(
            hbarTokenAddress,
        );
        expect(listing.lockEpochs).to.equal(icoLockEpochs);
        expect(listing.goal).to.equal(icoGoal);
    });

    it("reverts createCampaign when HBAR is sent", async function () {
        const { launchpad, workToken } = await deployFixture();

        const tokenFactory = await ethers.getContractFactory("MockERC20");
        const campaignToken = (await tokenFactory.deploy(
            "Campaign",
            "CMP",
        )) as any;
        await campaignToken.waitForDeployment();

        const listing = await buildValidListing(
            await workToken.getAddress(),
            await campaignToken.getAddress(),
        );

        await expect(launchpad.createCampaign(listing, 1n, { value: 1n }))
            .to.be.revertedWithCustomError(launchpad, "UnexpectedHbar")
            .withArgs(1n);
    });
});
