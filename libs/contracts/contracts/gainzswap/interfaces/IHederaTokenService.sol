// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice Minimal HTS precompile interface used by Workit HTS token logic.
interface IHederaTokenService {
	/// @notice Mints fungible supply to the token treasury account.
	/// @param token Address of the HTS token.
	/// @param amount Amount in smallest token units.
	/// @param metadata Empty for fungible mints.
	/// @return responseCode Hedera response code (22 = SUCCESS).
	/// @return newTotalSupply New total supply after mint.
	/// @return serialNumbers Empty for fungible mints.
	function mintToken(
		address token,
		uint64 amount,
		bytes[] memory metadata
	)
		external
		returns (
			int64 responseCode,
			uint64 newTotalSupply,
			int64[] memory serialNumbers
		);

	/// @notice Transfers fungible units between accounts.
	/// @param token Address of the HTS token.
	/// @param sender Source account.
	/// @param receiver Destination account.
	/// @param amount Amount in smallest units.
	/// @return responseCode Hedera response code (22 = SUCCESS).
	function transferToken(
		address token,
		address sender,
		address receiver,
		int64 amount
	) external returns (int64 responseCode);
}
