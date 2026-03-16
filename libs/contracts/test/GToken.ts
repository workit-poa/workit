import { expect } from "chai";
import { ethers } from "hardhat";

const HTS_PRECOMPILE = "0x0000000000000000000000000000000000000167";
const EPOCH_LENGTH = 24 * 60 * 60;

describe("GToken", function () {
	async function installMockHTS() {
		const mockFactory = await ethers.getContractFactory(
			"MockHederaTokenService",
		);
		const mockImplementation = await mockFactory.deploy();
		await mockImplementation.waitForDeployment();

		const runtimeCode = await ethers.provider.send("eth_getCode", [
			await mockImplementation.getAddress(),
			"latest",
		]);
		await ethers.provider.send("hardhat_setCode", [
			HTS_PRECOMPILE,
			runtimeCode,
		]);

		return mockFactory.attach(HTS_PRECOMPILE) as any;
	}

	async function deployFixture() {
		const [owner, alice, bob, carol] = await ethers.getSigners();
		const hts = await installMockHTS();

		const factory = await ethers.getContractFactory("GToken");
		const gToken = (await factory.deploy(owner.address, EPOCH_LENGTH)) as any;
		await gToken.waitForDeployment();
		return { owner, alice, bob, carol, hts, gToken };
	}

	async function createPositionToken(gToken: any, owner: any) {
		await gToken
			.connect(owner)
			.createPositionNft(1_000_000, "WorkIt Position NFT", "WGTPOS", "memo");
	}

	function liqInfo(owner: any, alice: any, pair: any, liqValue: bigint) {
		return {
			token0: owner.address,
			token1: alice.address,
			liquidity: liqValue * 5n,
			liqValue,
			pair: pair.address,
		};
	}

	it("sets constructor roles and epoch configuration", async function () {
		const { owner, gToken } = await deployFixture();

		expect(await gToken.name()).to.equal("WorkIt Governance Token");
		expect(await gToken.symbol()).to.equal("WGT");

		const DEFAULT_ADMIN_ROLE = await gToken.DEFAULT_ADMIN_ROLE();
		const MINTER_ROLE = await gToken.MINTER_ROLE();
		const TRANSFER_ROLE = await gToken.TRANSFER_ROLE();
		const UPDATE_ROLE = await gToken.UPDATE_ROLE();
		const BURN_ROLE = await gToken.BURN_ROLE();

		expect(await gToken.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(
			true,
		);
		expect(await gToken.hasRole(MINTER_ROLE, owner.address)).to.equal(true);
		expect(await gToken.hasRole(TRANSFER_ROLE, owner.address)).to.equal(true);
		expect(await gToken.hasRole(UPDATE_ROLE, owner.address)).to.equal(true);
		expect(await gToken.hasRole(BURN_ROLE, owner.address)).to.equal(true);

		const epochs = await gToken.epochs();
		expect(epochs.epochLength).to.equal(BigInt(EPOCH_LENGTH));
		expect(epochs.genesis).to.be.gt(0n);
	});

	it("creates and associates the HTS position NFT token", async function () {
		const { owner, alice, hts, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		const positionToken = await gToken.positionNftToken();
		expect(positionToken).to.not.equal(ethers.ZeroAddress);

		await gToken.connect(owner).associatePositionNft(alice.address);
		expect(await hts.isAssociated(positionToken, alice.address)).to.equal(true);
	});

	it("mints HTS-backed positions and tracks value in contract storage", async function () {
		const { owner, alice, bob, hts, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		await gToken.connect(owner).associatePositionNft(alice.address);

		const nonce = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 123n, 10n, liqInfo(owner, alice, bob, 100n));
		await gToken
			.connect(owner)
			.mintGToken(alice.address, 123n, 10n, liqInfo(owner, alice, bob, 100n));

		const positionToken = await gToken.positionNftToken();
		expect(await hts.ownerOf(positionToken, nonce)).to.equal(alice.address);
		expect(await gToken.getPositionOwner(nonce)).to.equal(alice.address);
		expect(await gToken.positionValueOf(nonce)).to.equal(100n);

		const balance = await gToken.getBalanceAt(alice.address, nonce);
		expect(balance.amount).to.equal(100n);
		expect(balance.votePower).to.be.gt(0n);
		expect(await gToken.totalSupply()).to.equal(100n);
		expect(await gToken.pairSupply(bob.address)).to.equal(100n);
	});

	it("transfers position serials and updates nonce ownership lists", async function () {
		const { owner, alice, bob, hts, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		await gToken.connect(owner).associatePositionNft(alice.address);
		await gToken.connect(owner).associatePositionNft(bob.address);

		const nonce = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 77n, 8n, liqInfo(owner, alice, bob, 120n));
		await gToken
			.connect(owner)
			.mintGToken(alice.address, 77n, 8n, liqInfo(owner, alice, bob, 120n));

		await gToken.connect(alice).transferPosition(alice.address, bob.address, nonce);

		const positionToken = await gToken.positionNftToken();
		expect(await hts.ownerOf(positionToken, nonce)).to.equal(bob.address);
		expect(await gToken.getPositionOwner(nonce)).to.equal(bob.address);
		expect(await gToken.getNonces(alice.address)).to.deep.equal([]);
		expect(await gToken.getNonces(bob.address)).to.deep.equal([nonce]);
		expect(await gToken.balanceOf(alice.address, nonce)).to.equal(0n);
		expect(await gToken.balanceOf(bob.address, nonce)).to.equal(120n);
	});

	it("splits positions with residual value and proportional attributes", async function () {
		const { owner, alice, bob, carol, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		await gToken.connect(owner).associatePositionNft(alice.address);
		await gToken.connect(owner).associatePositionNft(bob.address);
		await gToken.connect(owner).associatePositionNft(carol.address);

		const nonce = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 99n, 6n, liqInfo(owner, alice, bob, 100n));
		await gToken
			.connect(owner)
			.mintGToken(alice.address, 99n, 6n, liqInfo(owner, alice, bob, 100n));

		const originalAttr = await gToken.getAttributes(nonce);

		const [finalNonce, splitIds] = await gToken
			.connect(alice)
			.splitTransferFrom.staticCall(
				alice.address,
				nonce,
				[bob.address, carol.address],
				[30n, 40n],
			);
		await gToken
			.connect(alice)
			.splitTransferFrom(
				alice.address,
				nonce,
				[bob.address, carol.address],
				[30n, 40n],
			);

		expect(finalNonce).to.equal(nonce);
		expect(splitIds).to.have.length(2);

		expect(await gToken.positionValueOf(nonce)).to.equal(30n);
		expect(await gToken.positionValueOf(splitIds[0])).to.equal(30n);
		expect(await gToken.positionValueOf(splitIds[1])).to.equal(40n);
		expect(await gToken.getPositionOwner(nonce)).to.equal(alice.address);
		expect(await gToken.getPositionOwner(splitIds[0])).to.equal(bob.address);
		expect(await gToken.getPositionOwner(splitIds[1])).to.equal(carol.address);
		expect(await gToken.totalSupply()).to.equal(100n);

		const residualAttr = await gToken.getAttributes(nonce);
		const bobAttr = await gToken.getAttributes(splitIds[0]);
		const carolAttr = await gToken.getAttributes(splitIds[1]);

		expect(residualAttr.stakeWeight).to.equal((originalAttr.stakeWeight * 30n) / 100n);
		expect(bobAttr.stakeWeight).to.equal((originalAttr.stakeWeight * 30n) / 100n);
		expect(carolAttr.stakeWeight).to.equal((originalAttr.stakeWeight * 40n) / 100n);
		expect(residualAttr.lpDetails.liquidity).to.equal(
			(originalAttr.lpDetails.liquidity * 30n) / 100n,
		);
		expect(bobAttr.lpDetails.liqValue).to.equal(
			(originalAttr.lpDetails.liqValue * 30n) / 100n,
		);
		expect(carolAttr.lpDetails.liqValue).to.equal(
			(originalAttr.lpDetails.liqValue * 40n) / 100n,
		);
	});

	it("merges positions by burning source serials and minting one aggregate serial", async function () {
		const { owner, alice, bob, hts, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		await gToken.connect(owner).associatePositionNft(alice.address);

		const nonceA = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 100n, 3n, liqInfo(owner, alice, bob, 100n));
		await gToken
			.connect(owner)
			.mintGToken(alice.address, 100n, 3n, liqInfo(owner, alice, bob, 100n));

		const nonceB = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 300n, 8n, liqInfo(owner, alice, bob, 200n));
		await gToken
			.connect(owner)
			.mintGToken(alice.address, 300n, 8n, liqInfo(owner, alice, bob, 200n));

		const attrA = await gToken.getAttributes(nonceA);
		const attrB = await gToken.getAttributes(nonceB);

		const mergedNonce = await gToken
			.connect(alice)
			.mergeTransferFrom.staticCall(alice.address, alice.address, [nonceA, nonceB]);
		await gToken
			.connect(alice)
			.mergeTransferFrom(alice.address, alice.address, [nonceA, nonceB]);

		expect(await gToken.getPositionOwner(nonceA)).to.equal(ethers.ZeroAddress);
		expect(await gToken.getPositionOwner(nonceB)).to.equal(ethers.ZeroAddress);
		expect(await gToken.positionValueOf(nonceA)).to.equal(0n);
		expect(await gToken.positionValueOf(nonceB)).to.equal(0n);

		const positionToken = await gToken.positionNftToken();
		expect(await hts.ownerOf(positionToken, nonceA)).to.equal(ethers.ZeroAddress);
		expect(await hts.ownerOf(positionToken, nonceB)).to.equal(ethers.ZeroAddress);

		expect(await gToken.getPositionOwner(mergedNonce)).to.equal(alice.address);
		expect(await gToken.positionValueOf(mergedNonce)).to.equal(300n);
		expect(await gToken.totalSupply()).to.equal(300n);

		const mergedAttr = await gToken.getAttributes(mergedNonce);
		const expectedRewardPerShare = (100n * 100n + 300n * 200n + (300n - 1n)) / 300n;
		const expectedLastClaimEpoch =
			(attrB.lastClaimEpoch * attrB.stakeWeight +
				attrA.lastClaimEpoch * attrA.stakeWeight) /
			(attrA.stakeWeight + attrB.stakeWeight);

		expect(mergedAttr.rewardPerShare).to.equal(expectedRewardPerShare);
		expect(mergedAttr.epochStaked).to.equal(
			attrA.epochStaked < attrB.epochStaked
				? attrA.epochStaked
				: attrB.epochStaked,
		);
		expect(mergedAttr.epochsLocked).to.equal(
			attrA.epochsLocked > attrB.epochsLocked
				? attrA.epochsLocked
				: attrB.epochsLocked,
		);
		expect(mergedAttr.lastClaimEpoch).to.equal(expectedLastClaimEpoch);
		expect(mergedAttr.stakeWeight).to.equal(attrA.stakeWeight + attrB.stakeWeight);
		expect(mergedAttr.lpDetails.liquidity).to.equal(
			attrA.lpDetails.liquidity + attrB.lpDetails.liquidity,
		);
		expect(mergedAttr.lpDetails.liqValue).to.equal(
			attrA.lpDetails.liqValue + attrB.lpDetails.liqValue,
		);
	});

	it("reverts when HTS returns a non-success response code", async function () {
		const { owner, alice, hts, gToken } = await deployFixture();

		await createPositionToken(gToken, owner);
		await hts.setNextResponseCode(23);

		await expect(
			gToken.connect(owner).associatePositionNft(alice.address),
		)
			.to.be.revertedWithCustomError(gToken, "HederaCallFailed")
			.withArgs(23);
	});

});
