import type { HardhatRuntimeEnvironment } from "hardhat/types";
import type { Contract, Signer } from "ethers";

export const SAUCER_CORE_FACTORY_FQN =
	"vendor/saucerswap-core/contracts/UniswapV2Factory.sol:UniswapV2Factory";
export const SAUCER_CORE_PAIR_FQN =
	"vendor/saucerswap-core/contracts/UniswapV2Pair.sol:UniswapV2Pair";
export const SAUCER_CORE_WHBAR_FQN =
	"vendor/saucerswap-core/contracts/WHBAR.sol:WHBAR";
export const SAUCER_PERIPHERY_ROUTER02_FQN =
	"vendor/saucerswap-periphery/contracts/UniswapV2Router02.sol:UniswapV2Router02";

export interface DeployRequest {
	contractId: string; // contract name or fully-qualified name
	args?: readonly unknown[];
	signer?: Signer;
	value?: bigint;
}

export async function deployContract<T extends Contract = Contract>(
	hre: HardhatRuntimeEnvironment,
	request: DeployRequest,
): Promise<T> {
	const factory = await hre.ethers.getContractFactory(
		request.contractId,
		request.signer,
	);
	const instance = (await factory.deploy(...(request.args ?? []), {
		value: request.value ?? 0n,
	})) as T;
	await instance.waitForDeployment();
	return instance;
}

export async function installSaucerPrecompileMocks(
	hre: HardhatRuntimeEnvironment,
): Promise<{ htsPrecompile: string; exchangeRatePrecompile: string }> {
	const HTS_PRECOMPILE = "0x0000000000000000000000000000000000000167";
	const EXCHANGE_RATE_PRECOMPILE =
		"0x0000000000000000000000000000000000000168";

	const htsImpl = await deployContract(hre, {
		contractId: "MockHederaTokenService",
	});
	const exchangeRateImpl = await deployContract(hre, {
		contractId: "MockExchangeRatePrecompile",
	});

	const [htsRuntimeCode, exchangeRuntimeCode] = await Promise.all([
		hre.ethers.provider.send("eth_getCode", [
			await htsImpl.getAddress(),
			"latest",
		]),
		hre.ethers.provider.send("eth_getCode", [
			await exchangeRateImpl.getAddress(),
			"latest",
		]),
	]);

	await hre.ethers.provider.send("hardhat_setCode", [
		HTS_PRECOMPILE,
		htsRuntimeCode,
	]);
	await hre.ethers.provider.send("hardhat_setCode", [
		EXCHANGE_RATE_PRECOMPILE,
		exchangeRuntimeCode,
	]);

	return {
		htsPrecompile: HTS_PRECOMPILE,
		exchangeRatePrecompile: EXCHANGE_RATE_PRECOMPILE,
	};
}

export async function deploySaucerCoreFactory(
	hre: HardhatRuntimeEnvironment,
	params: {
		feeToSetter: string;
		pairCreateFeeTinycents?: bigint;
		tokenCreateFeeTinycents?: bigint;
		signer?: Signer;
	},
) {
	return deployContract(hre, {
		contractId: SAUCER_CORE_FACTORY_FQN,
		args: [
			params.feeToSetter,
			params.pairCreateFeeTinycents ?? 0n,
			params.tokenCreateFeeTinycents ?? 0n,
		],
		signer: params.signer,
	});
}

export async function deploySaucerCoreWhbar(
	hre: HardhatRuntimeEnvironment,
	params?: { signer?: Signer; value?: bigint },
) {
	return deployContract(hre, {
		contractId: SAUCER_CORE_WHBAR_FQN,
		signer: params?.signer,
		value: params?.value ?? 0n,
	});
}

export async function deploySaucerRouter02(
	hre: HardhatRuntimeEnvironment,
	params: {
		factory: string;
		whbar: string;
		signer?: Signer;
	},
) {
	return deployContract(hre, {
		contractId: SAUCER_PERIPHERY_ROUTER02_FQN,
		args: [params.factory, params.whbar],
		signer: params.signer,
	});
}
