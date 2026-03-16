import { expect } from "chai";
import { ethers } from "hardhat";

describe("Launchpad", function () {
	async function deployFixture() {
		const [owner] = await ethers.getSigners();

		const factoryFactory = await ethers.getContractFactory("MockUniswapV2Factory");
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

		const launchpadFactory = await ethers.getContractFactory("Launchpad");
		const launchpad = (await launchpadFactory.deploy(
			await uniswapFactory.getAddress(),
			owner.address,
			await staking.getAddress(),
		)) as any;
		await launchpad.waitForDeployment();

		return { owner, uniswapFactory, workToken, staking, launchpad };
	}

	async function buildValidListing(workTokenAddress: string, campaignTokenAddress: string) {
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
		const { owner, uniswapFactory, workToken, staking, launchpad } = await deployFixture();

		expect(await launchpad.owner()).to.equal(owner.address);
		expect(await launchpad.factory()).to.equal(await uniswapFactory.getAddress());
		expect(await launchpad.workToken()).to.equal(await workToken.getAddress());
		expect(await launchpad.campaignPair(owner.address)).to.equal(
			ethers.ZeroAddress,
		);

		expect(await staking.workToken()).to.equal(await workToken.getAddress());
	});

	it("reverts on zero-address constructor args", async function () {
		const [owner] = await ethers.getSigners();
		const launchpadFactory = await ethers.getContractFactory("Launchpad");

		await expect(
			launchpadFactory.deploy(
				ethers.ZeroAddress,
				owner.address,
				owner.address,
			),
		)
			.to.be.revertedWithCustomError(launchpadFactory, "InvalidAddress")
			.withArgs(ethers.ZeroAddress);

		await expect(
			launchpadFactory.deploy(
				owner.address,
				ethers.ZeroAddress,
				owner.address,
			),
		)
			.to.be.revertedWithCustomError(launchpadFactory, "InvalidAddress")
			.withArgs(ethers.ZeroAddress);

		await expect(
			launchpadFactory.deploy(
				owner.address,
				owner.address,
				ethers.ZeroAddress,
			),
		)
			.to.be.revertedWithCustomError(launchpadFactory, "InvalidAddress")
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

	it("creates a campaign and transitions it into funding", async function () {
		const { owner, launchpad, workToken } = await deployFixture();

		const tokenFactory = await ethers.getContractFactory("MockERC20");
		const campaignToken = (await tokenFactory.deploy("Campaign", "CMP")) as any;
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

		await expect(
			launchpad.createCampaign(listing, campaignTokenSupply),
		).to.not.be.reverted;

		const campaignAddress = await launchpad.campaignByTokens(
			await workToken.getAddress(),
			await campaignToken.getAddress(),
		);
		expect(campaignAddress).to.not.equal(ethers.ZeroAddress);

		const campaign = await ethers.getContractAt("Campaign", campaignAddress);
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

	it("reverts createCampaign when HBAR is sent", async function () {
		const { launchpad, workToken } = await deployFixture();

		const tokenFactory = await ethers.getContractFactory("MockERC20");
		const campaignToken = (await tokenFactory.deploy("Campaign", "CMP")) as any;
		await campaignToken.waitForDeployment();

		const listing = await buildValidListing(
			await workToken.getAddress(),
			await campaignToken.getAddress(),
		);

		await expect(
			launchpad.createCampaign(listing, 1n, { value: 1n }),
		)
			.to.be.revertedWithCustomError(launchpad, "UnexpectedHbar")
			.withArgs(1n);
	});
});
