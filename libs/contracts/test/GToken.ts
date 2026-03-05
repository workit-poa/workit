import { expect } from "chai";
import { ethers, upgrades } from "hardhat";

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
		const [owner, alice, bob] = await ethers.getSigners();
		const hts = await installMockHTS();

		const factory = await ethers.getContractFactory("GToken");
		const deployedProxy = await upgrades.deployProxy(
			factory,
			[owner.address, EPOCH_LENGTH],
			{
				initializer: "initialize",
				kind: "uups",
			},
		);
		await deployedProxy.waitForDeployment();

		const gToken = factory.attach(await deployedProxy.getAddress()) as any;
		return { owner, alice, bob, hts, gToken };
	}

	it("initializes with a single initializer and UUPS roles", async function () {
		const { owner, gToken } = await deployFixture();

		expect(await gToken.name()).to.equal("WorkIt Governance Token");
		expect(await gToken.symbol()).to.equal("WGT");

		const DEFAULT_ADMIN_ROLE = await gToken.DEFAULT_ADMIN_ROLE();
		const MINTER_ROLE = await gToken.MINTER_ROLE();
		const UPDATE_ROLE = await gToken.UPDATE_ROLE();
		const BURN_ROLE = await gToken.BURN_ROLE();

		expect(await gToken.hasRole(DEFAULT_ADMIN_ROLE, owner.address)).to.equal(
			true,
		);
		expect(await gToken.hasRole(MINTER_ROLE, owner.address)).to.equal(true);
		expect(await gToken.hasRole(UPDATE_ROLE, owner.address)).to.equal(true);
		expect(await gToken.hasRole(BURN_ROLE, owner.address)).to.equal(true);

		const epochs = await gToken.epochs();
		expect(epochs.epochLength).to.equal(BigInt(EPOCH_LENGTH));
		expect(epochs.genesis).to.be.gt(0n);

		await expect(
			gToken.initialize(owner.address, EPOCH_LENGTH),
		).to.be.reverted;
	});

	it("creates, associates, mints, transfers, and burns governance HTS NFTs", async function () {
		const { owner, alice, bob, hts, gToken } = await deployFixture();

		await gToken.connect(owner).createGovernanceNft(1_000_000);
		const governanceNftToken = await gToken.governanceNftToken();
		expect(governanceNftToken).to.not.equal(ethers.ZeroAddress);

		await gToken.connect(owner).associateGovernanceNft(alice.address);
		expect(await hts.isAssociated(governanceNftToken, alice.address)).to.equal(
			true,
		);

		const metadata = [ethers.toUtf8Bytes("workit-governance-position")];
		const [serial] = await gToken
			.connect(owner)
			.mintGovernanceNft.staticCall(alice.address, metadata);
		await gToken.connect(owner).mintGovernanceNft(alice.address, metadata);

		expect(await gToken.governanceNftSupply()).to.equal(1n);
		expect(await hts.ownerOf(governanceNftToken, serial)).to.equal(
			alice.address,
		);

		await gToken
			.connect(owner)
			.transferGovernanceNft(alice.address, bob.address, serial);
		expect(await hts.ownerOf(governanceNftToken, serial)).to.equal(bob.address);

		await gToken
			.connect(owner)
			.transferGovernanceNft(bob.address, await gToken.getAddress(), serial);
		expect(await hts.ownerOf(governanceNftToken, serial)).to.equal(
			await gToken.getAddress(),
		);

		await gToken.connect(owner).burnGovernanceNfts([serial]);
		expect(await gToken.governanceNftSupply()).to.equal(0n);
		expect(await hts.ownerOf(governanceNftToken, serial)).to.equal(
			ethers.ZeroAddress,
		);
	});

	it("keeps SFT accounting behavior for mintGToken", async function () {
		const { owner, alice, bob, gToken } = await deployFixture();

		const lpDetails = {
			token0: owner.address,
			token1: alice.address,
			liquidity: 500n,
			liqValue: 100n,
			pair: bob.address,
		};

		const nonce = await gToken
			.connect(owner)
			.mintGToken.staticCall(alice.address, 123n, 10n, lpDetails);
		await gToken.connect(owner).mintGToken(alice.address, 123n, 10n, lpDetails);

		const balance = await gToken.getBalanceAt(alice.address, nonce);
		expect(balance.amount).to.equal(100n);
		expect(balance.votePower).to.be.gt(0n);

		expect(await gToken.totalSupply()).to.equal(100n);
		expect(await gToken.pairSupply(bob.address)).to.equal(100n);
		expect(await gToken.totalStakeWeight()).to.be.gt(0n);
	});

	it("restricts UUPS upgrades to default admin", async function () {
		const { owner, alice, gToken } = await deployFixture();

		const gTokenV2Factory = await ethers.getContractFactory("GTokenV2");

		await expect(
			upgrades.upgradeProxy(
				await gToken.getAddress(),
				gTokenV2Factory.connect(alice),
			),
		).to.be.reverted;

		const upgraded = await upgrades.upgradeProxy(
			await gToken.getAddress(),
			gTokenV2Factory.connect(owner),
		);
		await upgraded.waitForDeployment();

		const upgradedContract = gTokenV2Factory.attach(
			await upgraded.getAddress(),
		) as any;
		expect(await upgradedContract.version()).to.equal(2n);
	});
});
