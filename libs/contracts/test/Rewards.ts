import { expect } from "chai";
import { ethers } from "hardhat";

const Q128 = 1n << 128n;

describe("Rewards", function () {
	async function deployFixture() {
		const [owner, user] = await ethers.getSigners();

		const tokenFactory = await ethers.getContractFactory("MockERC20");
		const workToken = (await tokenFactory.deploy("Work", "WRK")) as any;
		await workToken.waitForDeployment();

		const gTokenFactory = await ethers.getContractFactory(
			"MockGTokenForRewards",
		);
		const gToken = (await gTokenFactory.deploy()) as any;
		await gToken.waitForDeployment();

		const controllerFactory = await ethers.getContractFactory(
			"MockWorkEmissionController",
		);
		const workController = (await controllerFactory.deploy()) as any;
		await workController.waitForDeployment();

		const rewardsFactory = await ethers.getContractFactory("Rewards");
		const rewards = (await rewardsFactory.deploy()) as any;
		await rewards.waitForDeployment();

		await rewards.initialize(
			await workToken.getAddress(),
			await gToken.getAddress(),
			await workController.getAddress(),
		);

		return { owner, user, workToken, gToken, workController, rewards };
	}

	function baseAttributes(stakeWeight: bigint, rewardPerShare: bigint = 0n) {
		return {
			rewardPerShare,
			epochStaked: 0n,
			epochsLocked: 0n,
			lastClaimEpoch: 0n,
			stakeWeight,
			lpDetails: {
				token0: ethers.ZeroAddress,
				token1: ethers.ZeroAddress,
				liquidity: 0n,
				liqValue: 0n,
				pair: ethers.ZeroAddress,
			},
		};
	}

	it("initializes with Work naming and stores references", async function () {
		const { workToken, gToken, workController, rewards } = await deployFixture();

		expect(await rewards.workToken()).to.equal(await workToken.getAddress());
		expect(await rewards.gToken()).to.equal(await gToken.getAddress());
		expect(await rewards.workEmissionController()).to.equal(
			await workController.getAddress(),
		);
	});

	it("updates reserve and rewardPerShare when new WRK arrives", async function () {
		const { rewards, workToken, gToken } = await deployFixture();

		await gToken.setTotalStakeWeight(100n);
		await workToken.mint(await rewards.getAddress(), 1000n);
		await rewards.updateRewardReserve();

		expect(await rewards.rewardsReserve()).to.equal(1000n);
		expect(await rewards.rewardPerShare()).to.equal(10n * Q128);
	});

	it("keeps pending rewards unaccounted until there is stake weight", async function () {
		const { rewards, workToken, gToken } = await deployFixture();

		await gToken.setTotalStakeWeight(0n);
		await workToken.mint(await rewards.getAddress(), 500n);
		await rewards.updateRewardReserve();

		expect(await rewards.rewardsReserve()).to.equal(0n);
		expect(await rewards.rewardPerShare()).to.equal(0n);

		await gToken.setTotalStakeWeight(100n);
		await rewards.updateRewardReserve();

		expect(await rewards.rewardsReserve()).to.equal(500n);
		expect(await rewards.rewardPerShare()).to.equal(5n * Q128);
	});

	it("computes claimable including pending emission from controller", async function () {
		const { user, rewards, workToken, gToken, workController } =
			await deployFixture();

		await gToken.setTotalStakeWeight(100n);
		await gToken.setPosition(user.address, 1n, 1n, baseAttributes(40n));

		await workToken.mint(await rewards.getAddress(), 1000n);
		await rewards.updateRewardReserve();

		await workController.setStakersWorkToEmit(500n);

		const claimable = await rewards.claimableFor(user.address, [1n]);
		expect(claimable).to.equal(600n);
	});

	it("claims rewards, updates gToken attributes, and transfers WRK", async function () {
		const { user, rewards, workToken, gToken, workController } =
			await deployFixture();

		await gToken.setTotalStakeWeight(100n);
		await gToken.setPosition(user.address, 1n, 1n, baseAttributes(40n));

		await workToken.mint(await rewards.getAddress(), 1000n);
		await rewards.updateRewardReserve();
		await workController.setCurrentEpoch(7n);

		await rewards.connect(user).claimRewards([1n], user.address);

		expect(await workToken.balanceOf(user.address)).to.equal(400n);
		expect(await rewards.rewardsReserve()).to.equal(600n);

		const updated = await gToken.getPositionAttributes(user.address, 1n);
		expect(updated.rewardPerShare).to.equal(10n * Q128);
		expect(updated.lastClaimEpoch).to.equal(7n);
	});
});
