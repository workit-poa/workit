import { ethers, network } from "hardhat";

async function increaseTime(seconds: number) {
  await network.provider.send("evm_increaseTime", [seconds]);
  await network.provider.send("evm_mine");
}

async function main() {
  const [deployer, treasurySigner, user] = await ethers.getSigners();

  const admin = deployer.address;
  const treasury = treasurySigner.address;

  const erc20Factory = await ethers.getContractFactory("ERC20Mock");
  const quoteToken: any = await erc20Factory.deploy("USD Coin", "USDC");
  await quoteToken.waitForDeployment();

  const uniswapFactoryFactory = await ethers.getContractFactory("UniswapV2Factory");
  const dexFactory: any = await uniswapFactoryFactory.deploy(admin);
  await dexFactory.waitForDeployment();

  const routerFactory = await ethers.getContractFactory("WorkitDexRouter");
  const router: any = await routerFactory.deploy(await dexFactory.getAddress());
  await router.waitForDeployment();

  const workitTokenFactory = await ethers.getContractFactory("WorkitToken");
  const workit: any = await workitTokenFactory.deploy(admin, treasury);
  await workit.waitForDeployment();

  const gTokenFactory = await ethers.getContractFactory("WorkitGToken");
  const gToken: any = await gTokenFactory.deploy(admin, "");
  await gToken.waitForDeployment();

  const stakingFactory = await ethers.getContractFactory("WorkitStaking");
  const staking: any = await stakingFactory.deploy(
    admin,
    await workit.getAddress(),
    await gToken.getAddress(),
    ethers.ZeroAddress,
    treasury,
  );
  await staking.waitForDeployment();

  const emissionFactory = await ethers.getContractFactory("WorkitEmissionManager");
  const emissionManager: any = await emissionFactory.deploy(
    admin,
    await workit.getAddress(),
    await staking.getAddress(),
    treasury,
    24 * 60 * 60,
  );
  await emissionManager.waitForDeployment();

  const launchpadFactory = await ethers.getContractFactory("WorkitLaunchpad");
  const launchpad: any = await launchpadFactory.deploy(
    admin,
    await workit.getAddress(),
    await router.getAddress(),
    await gToken.getAddress(),
    await staking.getAddress(),
  );
  await launchpad.waitForDeployment();

  const governanceFactory = await ethers.getContractFactory("WorkitGovernance");
  const governance: any = await governanceFactory.deploy(
    admin,
    await workit.getAddress(),
    await launchpad.getAddress(),
    await staking.getAddress(),
    await emissionManager.getAddress(),
    60,
  );
  await governance.waitForDeployment();

  const createRole = await dexFactory.CREATE_ROLE();
  await (await dexFactory.grantRole(createRole, await launchpad.getAddress())).wait();

  const workitMinterRole = await workit.MINTER_ROLE();
  await (await workit.grantRole(workitMinterRole, await emissionManager.getAddress())).wait();
  await (await workit.mint(user.address, ethers.parseEther("100000"))).wait();
  await (await workit.mint(deployer.address, ethers.parseEther("100000"))).wait();

  await (await quoteToken.mint(user.address, ethers.parseEther("100000"))).wait();

  const poolManagerRole = await gToken.POOL_MANAGER_ROLE();
  const gTokenMinterRole = await gToken.MINTER_ROLE();
  await (await gToken.grantRole(poolManagerRole, await launchpad.getAddress())).wait();
  await (await gToken.grantRole(gTokenMinterRole, await launchpad.getAddress())).wait();

  const stakingPoolManagerRole = await staking.POOL_MANAGER_ROLE();
  await (await staking.grantRole(stakingPoolManagerRole, await launchpad.getAddress())).wait();
  await (await staking.grantRole(stakingPoolManagerRole, await governance.getAddress())).wait();
  await (await staking.setEmissionManager(await emissionManager.getAddress())).wait();

  const governanceRole = await launchpad.GOVERNANCE_ROLE();
  const finalizerRole = await launchpad.FINALIZER_ROLE();
  await (await launchpad.grantRole(governanceRole, await governance.getAddress())).wait();
  await (await launchpad.grantRole(finalizerRole, await governance.getAddress())).wait();

  const treasuryManagerRole = await emissionManager.TREASURY_MANAGER_ROLE();
  await (await emissionManager.grantRole(treasuryManagerRole, await governance.getAddress())).wait();

  const quoteProposal = await governance.proposeQuoteTokenApproval(
    await quoteToken.getAddress(),
    true,
    ethers.keccak256(ethers.toUtf8Bytes("Approve USDC quote token")),
  );
  const quoteReceipt = await quoteProposal.wait();
  const quoteProposalId = quoteReceipt?.logs?.length ? 1n : 1n;

  await (await governance.vote(quoteProposalId, true)).wait();
  await increaseTime(65);
  await (await governance.execute(quoteProposalId)).wait();

  const now = (await ethers.provider.getBlock("latest"))?.timestamp ?? Math.floor(Date.now() / 1000);
  const deadline = BigInt(now + 3600);

  await (await launchpad.connect(user).createCampaign(await quoteToken.getAddress(), ethers.parseEther("1000"), ethers.parseEther("1000"), deadline)).wait();

  await (await workit.connect(user).approve(await launchpad.getAddress(), ethers.parseEther("2000"))).wait();
  await (await quoteToken.connect(user).approve(await launchpad.getAddress(), ethers.parseEther("2000"))).wait();

  await (await launchpad.connect(user).deposit(1, ethers.parseEther("1000"), ethers.parseEther("1000"))).wait();

  const finalizeProposal = await governance.proposeCampaignFinalization(
    1,
    0,
    0,
    ethers.keccak256(ethers.toUtf8Bytes("Finalize campaign #1")),
  );
  await finalizeProposal.wait();

  await (await governance.vote(2, true)).wait();
  await increaseTime(65);
  await (await governance.execute(2)).wait();

  await (await launchpad.connect(user).claim(1, user.address)).wait();

  const campaign = await launchpad.campaigns(1);
  const tokenId = campaign.gTokenId;

  await (await gToken.connect(user).setApprovalForAll(await staking.getAddress(), true)).wait();
  await (await staking.connect(user).stake(tokenId, ethers.parseEther("1000"))).wait();

  await increaseTime(3 * 24 * 60 * 60);
  await (await staking.connect(user).claimRewards([tokenId], user.address)).wait();
  await (await staking.connect(user).withdraw(tokenId, ethers.parseEther("1000"), user.address)).wait();

  console.log("WorkIt E2E flow complete");
  console.log({
    campaignId: 1,
    pool: campaign.pool,
    gTokenId: tokenId.toString(),
    userWorkitBalance: (await workit.balanceOf(user.address)).toString(),
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
