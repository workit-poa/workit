import { ethers, network } from "hardhat";
import { artifacts } from "hardhat";
import dotenv from "dotenv";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { formatDecodedRevert } from "./utils/contract-error-decoder";

dotenv.config();
dotenv.config({ path: ".env.local", override: true });

const WRK_ICO_FUNDS = 734_999_999_775_143n;

function envString(name: string, fallback: string): string {
    const value = process.env[name]?.trim();
    return value && value.length > 0 ? value : fallback;
}

function envBigInt(name: string, fallback: bigint): bigint {
    const value = process.env[name]?.trim();
    if (!value) return fallback;

    try {
        return BigInt(value);
    } catch {
        throw new Error(`Invalid bigint for ${name}: ${value}`);
    }
}

function envNumber(name: string, fallback: number): number {
    const value = process.env[name]?.trim();
    if (!value) return fallback;

    const parsed = Number(value);
    if (!Number.isFinite(parsed) || parsed <= 0 || !Number.isInteger(parsed)) {
        throw new Error(`Invalid number for ${name}: ${value}`);
    }

    return parsed;
}

function envAddressList(name: string): string[] {
    const value = process.env[name]?.trim();
    if (!value) return [];

    const unique = new Set<string>();
    for (const raw of value.split(",")) {
        const trimmed = raw.trim();
        if (!trimmed) continue;
        unique.add(ethers.getAddress(trimmed));
    }

    return Array.from(unique);
}

const WORK_TOKEN_CREATE_HBAR_TO_SEND = envString(
    "WORK_TOKEN_CREATE_HBAR_TO_SEND",
    "15",
);
const POSITION_NFT_CREATE_HBAR_TO_SEND = envString(
    "POSITION_NFT_CREATE_HBAR_TO_SEND",
    envString("GOVERNANCE_NFT_CREATE_HBAR_TO_SEND", "15"),
);
const TOKEN_CREATE_GAS_LIMIT = envBigInt("DEPLOY_GAS_LIMIT", 1_000_000n);
const POSITION_NFT_MAX_SUPPLY = envBigInt(
    "POSITION_NFT_MAX_SUPPLY",
    envBigInt("GOVERNANCE_NFT_MAX_SUPPLY", 1_000_000n),
);
const POSITION_NFT_NAME = envString("POSITION_NFT_NAME", "WorkIt Position NFT");
const POSITION_NFT_SYMBOL = envString("POSITION_NFT_SYMBOL", "WGTPOS");
const POSITION_NFT_MEMO = envString("POSITION_NFT_MEMO", "workit-position-nft");
const GTOKEN_EPOCH_LENGTH_SECONDS = envNumber(
    "GTOKEN_EPOCH_LENGTH_SECONDS",
    24 * 60 * 60,
);
const POSITION_NFT_ASSOCIATE_ACCOUNTS = envAddressList(
    "POSITION_NFT_ASSOCIATE_ACCOUNTS",
);

// SaucerSwap V1 router on Hedera testnet: 0.0.19264
const SAUCERSWAP_V2_ROUTER_ADDRESS = ethers.getAddress(
    "0x0000000000000000000000000000000000004b40",
);
// SaucerSwap V1 factory on Hedera testnet: 0.0.1197038
const SAUCERSWAP_V2_FACTORY_ADDRESS = ethers.getAddress(
    envString(
        "SAUCERSWAP_V2_FACTORY_ADDRESS",
        "0x00000000000000000000000000000000000026e7",
    ),
);

// Zero address means "use freshly deployed WRK token as campaign token".
const ICO_CAMPAIGN_SUPPLY = WRK_ICO_FUNDS;
// 1 HBAR/WHBAR with 8 decimals.
const ICO_GOAL = envBigInt("ICO_GOAL", 1n * 10n ** 8n);
const ICO_LOCK_EPOCHS = 180n;
const ICO_DURATION_SECONDS = envNumber("ICO_DURATION_SECONDS", 36000);
const MIN_LAUNCHPAD_DURATION_SECONDS = 60;

const ERC20_ABI: string[] = [
    "function balanceOf(address account) external view returns (uint256)",
    "function allowance(address owner, address spender) external view returns (uint256)",
    "function approve(address spender, uint256 amount) external returns (bool)",
];

interface DeploymentAbiSpec {
    name: string;
    artifactName: string;
    address: string;
}

interface ContractDeploymentFile {
    address: string;
    abi: readonly unknown[];
}

async function deployUupsProxy(params: {
    contractName: string;
    initializeArgs: readonly unknown[];
}): Promise<{
    implementationAddress: string;
    proxyAddress: string;
    contract: any;
}> {
    const implementationFactory = await ethers.getContractFactory(
        params.contractName,
    );
    const implementation = await implementationFactory.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();

    const initData = implementationFactory.interface.encodeFunctionData(
        "initialize",
        params.initializeArgs,
    );
    const erc1967ProxyFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const proxy = await erc1967ProxyFactory.deploy(
        implementationAddress,
        initData,
    );
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();

    return {
        implementationAddress,
        proxyAddress,
        contract: implementationFactory.attach(proxyAddress) as any,
    };
}

async function writeDeploymentAbiLibrary(params: {
    chainId: number;
    contracts: DeploymentAbiSpec[];
}): Promise<void> {
    const deploymentsDir = resolve(
        process.cwd(),
        "deployments",
        String(params.chainId),
    );
    await mkdir(deploymentsDir, { recursive: true });

    await Promise.all(
        params.contracts.map(async (contract) => {
            const artifact = await artifacts.readArtifact(
                contract.artifactName,
            );
            const payload: ContractDeploymentFile = {
                address: ethers.getAddress(contract.address),
                abi: artifact.abi as readonly unknown[],
            };
            const filePath = resolve(deploymentsDir, `${contract.name}.json`);
            await writeFile(
                filePath,
                `${JSON.stringify(payload, null, 2)}\n`,
                "utf8",
            );
        }),
    );
}

async function main() {
    const [deployer] = await ethers.getSigners();
    const chain = await ethers.provider.getNetwork();
    const chainId = Number(chain.chainId);

    const routerAddress = SAUCERSWAP_V2_ROUTER_ADDRESS;
    const factoryAddress = SAUCERSWAP_V2_FACTORY_ADDRESS;

    const saucerRouter = await ethers.getContractAt(
        "UniswapV2Router02",
        routerAddress,
    );
    const WHBAR = await ethers.getContractAt(
        "WHBAR",
        await saucerRouter.WHBAR(),
    );
    const fundingTokenAddress = await WHBAR.token();

    console.log(`Network: ${network.name} (${chain.chainId.toString()})`);
    console.log(`Deployer (EVM): ${deployer.address}`);
    let rewardsImplementationAddress = ethers.ZeroAddress;

    console.log("Step 1/13 - Deploy WORK implementation + UUPS proxy");
    const workDeployment = await deployUupsProxy({
        contractName: "WORK",
        initializeArgs: [deployer.address],
    });
    const workAddress = workDeployment.proxyAddress;
    const workImplementationAddress = workDeployment.implementationAddress;
    const work = workDeployment.contract;
    console.log(`WORK implementation deployed: ${workImplementationAddress}`);
    console.log(`WORK proxy deployed: ${workAddress}`);

    console.log("Step 2/13 - Create WRK HTS token via WORK");
    console.log(`Using gas limit: ${TOKEN_CREATE_GAS_LIMIT.toString()}`);
    console.log(
        `Sending ${WORK_TOKEN_CREATE_HBAR_TO_SEND} HBAR for WRK token creation...`,
    );
    const createWorkTokenTx = await work.createWorkToken({
        gasLimit: TOKEN_CREATE_GAS_LIMIT,
        value: ethers.parseEther(WORK_TOKEN_CREATE_HBAR_TO_SEND),
    });
    await createWorkTokenTx.wait();
    const wrkTokenAddress = await work.token();
    console.log(`WRK token EVM address: ${wrkTokenAddress}`);

    const campaignTokenAddress = wrkTokenAddress;
    const campaignToken = (await ethers.getContractAt(
        ERC20_ABI,
        campaignTokenAddress,
    )) as any;

    const deployerCampaignBalance = (await campaignToken.balanceOf(
        deployer.address,
    )) as bigint;
    if (deployerCampaignBalance < ICO_CAMPAIGN_SUPPLY) {
        throw new Error(
            `Insufficient campaign token balance. required=${ICO_CAMPAIGN_SUPPLY.toString()} available=${deployerCampaignBalance.toString()}`,
        );
    }

    console.log("Step 3/13 - Deploy GToken implementation + UUPS proxy");
    const gTokenDeployment = await deployUupsProxy({
        contractName: "GToken",
        initializeArgs: [deployer.address, GTOKEN_EPOCH_LENGTH_SECONDS],
    });
    const gTokenAddress = gTokenDeployment.proxyAddress;
    const gTokenImplementationAddress = gTokenDeployment.implementationAddress;
    const gToken = gTokenDeployment.contract;

    console.log(
        `GToken implementation deployed: ${gTokenImplementationAddress}`,
    );
    console.log(`GToken proxy deployed: ${gTokenAddress}`);

    console.log("Step 6/13 - Deploy or resolve Rewards contract");
    let rewardsAddress: string;
    const externalRewardsRaw = process.env.WORK_REWARDS_ADDRESS?.trim();
    if (externalRewardsRaw) {
        rewardsAddress = ethers.getAddress(externalRewardsRaw);
        console.log(`Using existing Rewards contract: ${rewardsAddress}`);
    } else {
        const rewardsDeployment = await deployUupsProxy({
            contractName: "Rewards",
            initializeArgs: [gTokenAddress, workAddress, deployer.address],
        });
        rewardsAddress = rewardsDeployment.proxyAddress;
        rewardsImplementationAddress = rewardsDeployment.implementationAddress;
        console.log(`Rewards deployed: ${rewardsAddress}`);
    }

    console.log("Step 7/13 - Grant GToken UPDATE_ROLE to Rewards");
    const updateRole = await gToken.UPDATE_ROLE();
    const hasUpdateRole = await gToken.hasRole(updateRole, rewardsAddress);
    if (!hasUpdateRole) {
        const grantUpdateRoleTx = await gToken.grantRole(
            updateRole,
            rewardsAddress,
        );
        await grantUpdateRoleTx.wait();
        console.log(`Granted UPDATE_ROLE to Rewards: ${rewardsAddress}`);
    } else {
        console.log("Rewards already has UPDATE_ROLE");
    }

    console.log("Step 8/13 - Configure staking rewards collector");
    const stakingRaw = process.env.WORK_STAKING_ADDRESS?.trim();
    const stakingCollectorAddress = stakingRaw
        ? ethers.getAddress(stakingRaw)
        : rewardsAddress;

    const stakingTx = await work.setStakingRewardsCollector(
        stakingCollectorAddress,
    );
    await stakingTx.wait();
    console.log(`Staking rewards collector set: ${stakingCollectorAddress}`);

    let launchpadStakingAddress = ethers.ZeroAddress;
    let stakingImplementationAddress = ethers.ZeroAddress;
    let launchpadAddress = ethers.ZeroAddress;
    let launchpadImplementationAddress = ethers.ZeroAddress;
    let campaignImplementationAddress = ethers.ZeroAddress;
    let campaignBeaconAddress = ethers.ZeroAddress;
    let campaignAddress = ethers.ZeroAddress;
    let launchpadFactoryAddress = ethers.ZeroAddress;

    console.log(
        "Launchpad orchestration enabled: deploying Staking + Launchpad",
    );

    launchpadFactoryAddress = factoryAddress;
    if (launchpadFactoryAddress === ethers.ZeroAddress) {
        throw new Error("Launchpad factory address resolved to zero address");
    }
    console.log(`Using SaucerSwap factory: ${launchpadFactoryAddress}`);

    console.log("Step 9/13 - Deploy Staking implementation + UUPS proxy");
    const stakingDeployment = await deployUupsProxy({
        contractName: "Staking",
        initializeArgs: [
            routerAddress,
            rewardsAddress,
            wrkTokenAddress,
            gTokenAddress,
            deployer.address,
        ],
    });
    launchpadStakingAddress = stakingDeployment.proxyAddress;
    stakingImplementationAddress = stakingDeployment.implementationAddress;
    const staking = stakingDeployment.contract;
    console.log(
        `Staking implementation deployed: ${stakingImplementationAddress}`,
    );
    console.log(`Staking proxy deployed: ${launchpadStakingAddress}`);

    console.log("Step 10/13 - Grant GToken MINTER_ROLE to Staking");
    const minterRole = await gToken.MINTER_ROLE();
    const hasMinterRole = await gToken.hasRole(
        minterRole,
        launchpadStakingAddress,
    );
    if (!hasMinterRole) {
        const grantMinterRoleTx = await gToken.grantRole(
            minterRole,
            launchpadStakingAddress,
        );
        await grantMinterRoleTx.wait();
        console.log(
            `Granted MINTER_ROLE to Staking: ${launchpadStakingAddress}`,
        );
    } else {
        console.log("Staking already has MINTER_ROLE");
    }

    console.log(
        "Step 11/13 - Deploy Campaign implementation + beacon + Launchpad proxy (UUPS)",
    );
    const campaignFactory = await ethers.getContractFactory("Campaign");
    const campaignImplementation = await campaignFactory
        .deploy()
        .catch((error: unknown) => {
            throw formatDecodedRevert(
                "Campaign implementation deploy transaction submission",
                error,
                campaignFactory.interface,
            );
        });
    await campaignImplementation.waitForDeployment();
    campaignImplementationAddress = await campaignImplementation.getAddress();
    console.log(
        `Campaign implementation deployed: ${campaignImplementationAddress}`,
    );

    const beaconFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
    );
    const campaignBeacon = await beaconFactory.deploy(
        campaignImplementationAddress,
        deployer.address,
    );
    await campaignBeacon.waitForDeployment();
    campaignBeaconAddress = await campaignBeacon.getAddress();
    console.log(`Campaign beacon deployed: ${campaignBeaconAddress}`);

    const launchpadImplFactory = await ethers.getContractFactory("Launchpad");
    const launchpadImplementation = await launchpadImplFactory.deploy();
    await launchpadImplementation.waitForDeployment();
    launchpadImplementationAddress = await launchpadImplementation.getAddress();
    console.log(
        `Launchpad implementation deployed: ${launchpadImplementationAddress}`,
    );

    const launchpadInitData = launchpadImplFactory.interface.encodeFunctionData(
        "initialize",
        [
            launchpadFactoryAddress,
            gTokenAddress,
            launchpadStakingAddress,
            campaignBeaconAddress,
            deployer.address,
        ],
    );
    const erc1967ProxyFactory = await ethers.getContractFactory(
        "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
    );
    const launchpadProxy = await erc1967ProxyFactory.deploy(
        launchpadImplementationAddress,
        launchpadInitData,
    );
    await launchpadProxy.waitForDeployment();
    launchpadAddress = await launchpadProxy.getAddress();
    const launchpadContract = launchpadImplFactory.attach(
        launchpadAddress,
    ) as any;
    console.log(`Launchpad proxy deployed: ${launchpadAddress}`);

    const deploymentContracts: DeploymentAbiSpec[] = [
        {
            name: "WORK",
            artifactName: "WORK",
            address: workAddress,
        },
        {
            name: "WORKImplementation",
            artifactName: "WORK",
            address: workImplementationAddress,
        },
        {
            name: "GToken",
            artifactName: "GToken",
            address: gTokenAddress,
        },
        {
            name: "GTokenImplementation",
            artifactName: "GToken",
            address: gTokenImplementationAddress,
        },
        {
            name: "Rewards",
            artifactName: "Rewards",
            address: rewardsAddress,
        },
        {
            name: "Staking",
            artifactName: "Staking",
            address: launchpadStakingAddress,
        },
        {
            name: "StakingImplementation",
            artifactName: "Staking",
            address: stakingImplementationAddress,
        },
        {
            name: "Launchpad",
            artifactName: "Launchpad",
            address: launchpadAddress,
        },
        {
            name: "LaunchpadImplementation",
            artifactName: "Launchpad",
            address: launchpadImplementationAddress,
        },
        {
            name: "CampaignImplementation",
            artifactName: "Campaign",
            address: campaignImplementationAddress,
        },
        {
            name: "CampaignBeacon",
            artifactName:
                "@openzeppelin/contracts/proxy/beacon/UpgradeableBeacon.sol:UpgradeableBeacon",
            address: campaignBeaconAddress,
        },
        {
            name: "Campaign",
            artifactName: "Campaign",
            address: campaignAddress,
        },
    ];

    if (rewardsImplementationAddress != ethers.ZeroAddress) {
        deploymentContracts.push({
            name: "RewardsImplementation",
            artifactName: "Rewards",
            address: rewardsImplementationAddress,
        });
    }

    await writeDeploymentAbiLibrary({
        chainId,
        contracts: deploymentContracts,
    });
    console.log(
        `Deployment ABI library generated at libs/contracts/deployments/${chainId}/{ContractName}.json`,
    );

    const setAssociationCallerTx = await staking.setAssociationCaller(
        launchpadAddress,
        true,
    );
    await setAssociationCallerTx.wait();
    console.log(
        `Staking association caller enabled for Launchpad: ${launchpadAddress}`,
    );

    console.log("Step 12/13 - Prepare ICO campaign balances and approvals");
    if (ICO_CAMPAIGN_SUPPLY <= 0n) {
        throw new Error("ICO_CAMPAIGN_SUPPLY must be greater than zero");
    }

    if (ICO_LOCK_EPOCHS <= 0n) {
        throw new Error("ICO_LOCK_EPOCHS must be greater than zero");
    }

    if (ICO_GOAL <= 0n) {
        throw new Error("ICO_GOAL must be a positive value");
    }
    if (ICO_DURATION_SECONDS <= MIN_LAUNCHPAD_DURATION_SECONDS) {
        throw new Error(
            `ICO_DURATION_SECONDS must be greater than ${MIN_LAUNCHPAD_DURATION_SECONDS} seconds for Launchpad.createCampaign`,
        );
    }

    const allowance = (await campaignToken.allowance(
        deployer.address,
        launchpadAddress,
    )) as bigint;
    if (allowance < ICO_CAMPAIGN_SUPPLY) {
        const approveCampaignTokenTx = await campaignToken.approve(
            launchpadAddress,
            ICO_CAMPAIGN_SUPPLY,
        );
        await approveCampaignTokenTx.wait();
        console.log("Campaign token allowance granted to Launchpad");
    }

    console.log(
        `Step 13/13 - Create WRK/ ICO campaign on Launchpad (funding token ${fundingTokenAddress})`,
    );
    const latestBlock = await ethers.provider.getBlock("latest");
    const now = latestBlock?.timestamp ?? Math.floor(Date.now() / 1000);
    const deadline = BigInt(now + ICO_DURATION_SECONDS);

    const createCampaignTx = await launchpadContract
        .createCampaign(
            {
                campaignToken: campaignTokenAddress,
                fundingToken: fundingTokenAddress,
                lockEpochs: ICO_LOCK_EPOCHS,
                goal: ICO_GOAL,
                deadline,
            },
            ICO_CAMPAIGN_SUPPLY,
            {gasLimit:2_000_000}
        )
        .catch((error: unknown) => {
            throw formatDecodedRevert(
                "Launchpad.createCampaign transaction submission",
                error,
                launchpadContract.interface,
            );
        });
    await createCampaignTx.wait().catch((error: unknown) => {
        throw formatDecodedRevert(
            "Launchpad.createCampaign transaction submission",
            error,
            launchpadContract.interface,
        );
    });

    campaignAddress = await launchpadContract.campaignByTokens(
        fundingTokenAddress,
        campaignTokenAddress,
    );
    console.log(`ICO campaign deployed: ${campaignAddress}`);

    console.log("Launchpad orchestration complete");

    console.log("Deployment complete.");
    console.log(`work=${workAddress}`);
    console.log(`wrkTokenAddress=${wrkTokenAddress}`);
    console.log(`workImplementation=${workImplementationAddress}`);
    console.log(`gToken=${gTokenAddress}`);
    console.log(`gTokenImplementation=${gTokenImplementationAddress}`);
    console.log(`rewardsAddress=${rewardsAddress}`);
    console.log(`rewardsImplementation=${rewardsImplementationAddress}`);
    console.log(`stakingCollector=${stakingCollectorAddress}`);
    console.log(`launchpadStakingAddress=${launchpadStakingAddress}`);
    console.log(`stakingImplementation=${stakingImplementationAddress}`);
    console.log(`launchpadFactoryAddress=${launchpadFactoryAddress}`);
    console.log(`campaignImplementation=${campaignImplementationAddress}`);
    console.log(`campaignBeacon=${campaignBeaconAddress}`);
    console.log(`launchpadImplementation=${launchpadImplementationAddress}`);
    console.log(`launchpadAddress=${launchpadAddress}`);
    console.log(`launchpadWRKAddress=${wrkTokenAddress}`);
    console.log(`campaignAddress=${campaignAddress}`);
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
