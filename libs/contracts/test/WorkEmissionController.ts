import { expect } from "chai";
import { ethers } from "hardhat";

describe("WorkEmissionController", function () {
	async function deployControllerFixture() {
		const [owner, other] = await ethers.getSigners();
		const controllerFactory = await ethers.getContractFactory(
			"WorkEmissionController",
		);
		const controller = (await controllerFactory.deploy(owner.address)) as any;
		await controller.waitForDeployment();
		return { owner, other, controller };
	}

	it("sets ownership and epoch defaults in constructor", async function () {
		const { owner, controller } = await deployControllerFixture();

		expect(await controller.owner()).to.equal(owner.address);
		expect(await controller.wrkToken()).to.equal(ethers.ZeroAddress);
		expect(await controller.rewards()).to.equal(ethers.ZeroAddress);
		expect(await controller.trackedSupply()).to.equal(0n);
		expect(await controller.currentEpoch()).to.equal(0n);

		const epochs = await controller.epochs();
		expect(epochs.genesis).to.be.gt(0n);
		expect(epochs.epochLength).to.equal(24n * 60n * 60n);

		expect(await controller.lastTimestamp()).to.be.gte(epochs.genesis);
	});

	it("allows only the owner to configure staking rewards collector", async function () {
		const { owner, other, controller } = await deployControllerFixture();

		await expect(
			controller
				.connect(other)
				.setStakingRewardsCollector(other.address),
		)
			.to.be.revertedWithCustomError(controller, "OwnableUnauthorizedAccount")
			.withArgs(other.address);

		await expect(
			controller
				.connect(owner)
				.setStakingRewardsCollector(ethers.ZeroAddress),
		).to.be.revertedWithCustomError(controller, "InvalidAddress");

		await controller
			.connect(owner)
			.setStakingRewardsCollector(other.address);
		expect(await controller.rewards()).to.equal(other.address);
	});
});
