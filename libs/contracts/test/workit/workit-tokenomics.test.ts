import { expect } from "chai";
import { ethers } from "hardhat";

const EPOCH_SECONDS = 24 * 60 * 60;

describe("WorkIt Tokenomics", function () {
  async function latestTimestamp(): Promise<number> {
    const block = await ethers.provider.getBlock("latest");
    return block?.timestamp ?? 0;
  }

  async function increaseTime(seconds: number): Promise<void> {
    await ethers.provider.send("evm_increaseTime", [seconds]);
    await ethers.provider.send("evm_mine", []);
  }

  async function mineBlocks(blocks: number): Promise<void> {
    for (let i = 0; i < blocks; i++) {
      await ethers.provider.send("evm_mine", []);
    }
  }

  async function deployFixture() {
    const [admin, alice, bob, treasury] = await ethers.getSigners();

    const WorkitToken = await ethers.getContractFactory("WorkitToken");
    const workit: any = await WorkitToken.deploy(
      admin.address,
      treasury.address,
      ethers.parseEther("1000000"),
    );
    await workit.waitForDeployment();

    const WorkitGToken = await ethers.getContractFactory("WorkitGToken");
    const gToken: any = await WorkitGToken.deploy(admin.address, "ipfs://workit-gtoken/{id}.json");
    await gToken.waitForDeployment();

    const MockERC20 = await ethers.getContractFactory("MockERC20");
    const quote: any = await MockERC20.deploy("Mock USDC", "mUSDC");
    await quote.waitForDeployment();

    const MockV2Factory = await ethers.getContractFactory("MockV2Factory");
    const factory: any = await MockV2Factory.deploy(admin.address);
    await factory.waitForDeployment();

    const MockV2Router = await ethers.getContractFactory("MockV2Router");
    const router: any = await MockV2Router.deploy(
      await factory.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
    );
    await router.waitForDeployment();

    const WorkitLaunchpad = await ethers.getContractFactory("WorkitLaunchpad");
    const launchpad: any = await WorkitLaunchpad.deploy(
      admin.address,
      await workit.getAddress(),
      await gToken.getAddress(),
      await factory.getAddress(),
      await router.getAddress(),
    );
    await launchpad.waitForDeployment();

    const EmissionsManager = await ethers.getContractFactory("EmissionsManager");
    const emissions: any = await EmissionsManager.deploy(
      admin.address,
      await workit.getAddress(),
      EPOCH_SECONDS,
      0,
    );
    await emissions.waitForDeployment();

    const WorkitStaking = await ethers.getContractFactory("WorkitStaking");
    const staking: any = await WorkitStaking.deploy(admin.address, await gToken.getAddress());
    await staking.waitForDeployment();

    const EntityRegistry = await ethers.getContractFactory("EntityRegistry");
    const entityRegistry: any = await EntityRegistry.deploy(admin.address);
    await entityRegistry.waitForDeployment();

    const WorkitGovernance = await ethers.getContractFactory("WorkitGovernance");
    const governance: any = await WorkitGovernance.deploy(
      admin.address,
      await workit.getAddress(),
      0,
      1,
      5,
      ethers.parseEther("1"),
      ethers.parseEther("50"),
    );
    await governance.waitForDeployment();

    const gTokenMinterRole = await gToken.MINTER_ROLE();
    await gToken.grantRole(gTokenMinterRole, await launchpad.getAddress());

    const workitMinterRole = await workit.MINTER_ROLE();
    await workit.grantRole(workitMinterRole, await emissions.getAddress());

    await staking.setEmissionsManager(await emissions.getAddress());
    const stakingRole = await emissions.STAKING_ROLE();
    await emissions.grantRole(stakingRole, await staking.getAddress());

    const governanceRole = await emissions.GOVERNANCE_ROLE();
    await emissions.grantRole(governanceRole, await governance.getAddress());

    await emissions.configurePool(1, ethers.parseEther("10"), true);

    await workit.mint(alice.address, ethers.parseEther("10000"));
    await workit.mint(bob.address, ethers.parseEther("10000"));
    await quote.mint(alice.address, ethers.parseEther("10000"));
    await quote.mint(bob.address, ethers.parseEther("10000"));

    return {
      admin,
      alice,
      bob,
      treasury,
      workit,
      gToken,
      quote,
      factory,
      router,
      launchpad,
      emissions,
      staking,
      governance,
      entityRegistry,
    };
  }

  async function createAndFundCampaign(fixture: any) {
    const { alice, bob, workit, quote, launchpad } = fixture;
    const chainId = (await ethers.provider.getNetwork()).chainId;

    const now = await latestTimestamp();
    const start = now - 10;
    const end = now + 3600;

    await launchpad.createCampaign(
      await quote.getAddress(),
      ethers.parseEther("1000"),
      ethers.parseEther("1000"),
      start,
      end,
      false,
      alice.address,
      chainId,
    );

    const campaignId = 1n;

    await workit.connect(alice).approve(await launchpad.getAddress(), ethers.parseEther("600"));
    await workit.connect(bob).approve(await launchpad.getAddress(), ethers.parseEther("400"));
    await quote.connect(alice).approve(await launchpad.getAddress(), ethers.parseEther("600"));
    await quote.connect(bob).approve(await launchpad.getAddress(), ethers.parseEther("400"));

    await launchpad.connect(alice).depositWorkit(campaignId, ethers.parseEther("600"));
    await launchpad.connect(bob).depositWorkit(campaignId, ethers.parseEther("400"));
    await launchpad.connect(alice).depositQuote(campaignId, ethers.parseEther("600"));
    await launchpad.connect(bob).depositQuote(campaignId, ethers.parseEther("400"));

    return campaignId;
  }

  it("creates launchpad campaign, adds liquidity, and mints pool GTokens", async function () {
    const fixture = await deployFixture();
    const { alice, bob, launchpad, factory, workit, quote, gToken } = fixture;

    const campaignId = await createAndFundCampaign(fixture);

    await launchpad.finalizeLaunch(
      campaignId,
      ethers.parseEther("900"),
      ethers.parseEther("900"),
      BigInt((await latestTimestamp()) + 3600),
    );

    const campaign = await launchpad.campaigns(campaignId);
    expect(campaign.finalized).to.equal(true);
    expect(campaign.liquidityAdded).to.equal(true);

    const pair = await factory.getPair(await workit.getAddress(), await quote.getAddress());
    expect(pair).to.not.equal(ethers.ZeroAddress);

    const tokenId = await gToken.poolToTokenId(pair);
    expect(tokenId).to.not.equal(0n);

    expect(await gToken.balanceOf(alice.address, tokenId)).to.equal(ethers.parseEther("600"));
    expect(await gToken.balanceOf(bob.address, tokenId)).to.equal(ethers.parseEther("400"));
  });

  it("accrues and claims emissions from staked GTokens", async function () {
    const fixture = await deployFixture();
    const { alice, launchpad, factory, workit, quote, gToken, staking, emissions, entityRegistry } = fixture;

    const campaignId = await createAndFundCampaign(fixture);
    await launchpad.finalizeLaunch(
      campaignId,
      ethers.parseEther("900"),
      ethers.parseEther("900"),
      BigInt((await latestTimestamp()) + 3600),
    );

    const pair = await factory.getPair(await workit.getAddress(), await quote.getAddress());
    const poolId = await gToken.poolToTokenId(pair);

    await emissions.configurePool(poolId, ethers.parseEther("50"), true);

    await gToken.connect(alice).setApprovalForAll(await staking.getAddress(), true);
    await staking.connect(alice).stake(poolId, ethers.parseEther("600"));

    await increaseTime(EPOCH_SECONDS);
    const before = await workit.balanceOf(alice.address);
    await staking.connect(alice).claimRewards(alice.address);
    const firstClaimDelta = (await workit.balanceOf(alice.address)) - before;
    expect(firstClaimDelta).to.be.gte(ethers.parseEther("50") - 1n);
    expect(firstClaimDelta).to.be.lte(ethers.parseEther("50"));

    await emissions.setEntityRegistry(await entityRegistry.getAddress());
    await entityRegistry.setRewardMultiplier(alice.address, 15000);

    await increaseTime(EPOCH_SECONDS);
    const beforeBoosted = await workit.balanceOf(alice.address);
    await staking.connect(alice).claimRewards(alice.address);
    const secondClaimDelta = (await workit.balanceOf(alice.address)) - beforeBoosted;

    expect(secondClaimDelta).to.be.gte(ethers.parseEther("75") - 1n);
    expect(secondClaimDelta).to.be.lte(ethers.parseEther("75"));
  });

  it("executes governance proposal to reconfigure pool emissions", async function () {
    const fixture = await deployFixture();
    const { alice, bob, governance, emissions, workit } = fixture;

    await workit.mint(alice.address, ethers.parseEther("100"));
    await workit.mint(bob.address, ethers.parseEther("100"));

    const data = emissions.interface.encodeFunctionData("configurePool", [77, ethers.parseEther("33"), true]);
    await governance.connect(alice).propose(await emissions.getAddress(), 0, data, "Set pool 77 emission to 33 WORKIT");

    await mineBlocks(2);
    await governance.connect(alice).vote(1, true);
    await governance.connect(bob).vote(1, true);

    await mineBlocks(6);
    await governance.execute(1);

    const pool = await emissions.pools(77);
    expect(pool.emissionRatePerEpoch).to.equal(ethers.parseEther("33"));
    expect(pool.enabled).to.equal(true);
  });

  it("runs end-to-end flow: token -> launchpad -> liquidity -> gtoken -> stake -> emit -> claim", async function () {
    const fixture = await deployFixture();
    const { alice, launchpad, factory, workit, quote, gToken, staking, emissions } = fixture;

    const campaignId = await createAndFundCampaign(fixture);

    await launchpad.finalizeLaunch(
      campaignId,
      ethers.parseEther("900"),
      ethers.parseEther("900"),
      BigInt((await latestTimestamp()) + 3600),
    );

    const pair = await factory.getPair(await workit.getAddress(), await quote.getAddress());
    const poolId = await gToken.poolToTokenId(pair);
    expect(poolId).to.not.equal(0n);

    await emissions.configurePool(poolId, ethers.parseEther("20"), true);

    await gToken.connect(alice).setApprovalForAll(await staking.getAddress(), true);
    await staking.connect(alice).stake(poolId, ethers.parseEther("600"));

    await increaseTime(EPOCH_SECONDS * 2);

    const before = await workit.balanceOf(alice.address);
    await staking.connect(alice).claimRewards(alice.address);
    const after = await workit.balanceOf(alice.address);

    expect(after - before).to.be.gte(ethers.parseEther("40") - 1n);
    expect(after - before).to.be.lte(ethers.parseEther("40"));
  });
});
