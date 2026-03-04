// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

/// @title Referral System
/// @notice Defines user and referral structures for the referral system.
struct ReferralInfo {
	uint256 id; // Unique identifier for the referral
	address referralAddress; // Address of the referred user
}

struct User {
	uint256 id; // Unique identifier for the user
	address addr; // Address of the user
	uint256 referrerId; // ID of the referrer, if any
	uint256[] referrals; // List of referral IDs associated with the user
}

// /// @title UserModuleLib
// /// @notice A library that provides utility functions for managing users and referrals.
// library UserModuleLib {
// 	/// @notice Gets the referrer ID and address of a given user.
// 	/// @param userAddress The address of the user.
// 	/// @return referrerId The ID of the referrer, or 0 if none.
// 	/// @return referrerAddress The address of the referrer, or address(0) if none.
// 	function getReferrer(
// 		UserModule.UserStorage storage $,
// 		address userAddress
// 	) external view returns (uint256 referrerId, address referrerAddress) {
// 		User storage user = $.users[userAddress];
// 		referrerId = user.referrerId;
// 		referrerAddress = $.userIdToAddress[referrerId];
// 	}

// 	/// @notice Retrieves the list of referrals for a given user.
// 	/// @param userAddress The address of the user.
// 	/// @return referrals An array of `ReferralInfo` structs representing the user's referrals.
// 	function getReferrals(
// 		UserModule.UserStorage storage $,
// 		address userAddress
// 	) external view returns (ReferralInfo[] memory) {
// 		uint256[] storage referralIds = $.users[userAddress].referrals;
// 		uint256 length = referralIds.length;
// 		ReferralInfo[] memory referrals = new ReferralInfo[](length);

// 		for (uint256 i = 0; i < length; i++) {
// 			uint256 id = referralIds[i];
// 			referrals[i] = ReferralInfo(id, $.userIdToAddress[id]);
// 		}
// 		return referrals;
// 	}

// 	/// @notice Creates a new user or retrieves an existing user ID.
// 	/// @param userAddr The address of the user.
// 	/// @param referrerId The ID of the referrer.
// 	/// @return userId The unique ID assigned to the user.
// 	/// @return isNewUser Indicates whether a new user was created.
// 	/// @return isRefAdded Indicates whether the referrer was successfully linked.
// 	function createOrGetUserId(
// 		UserModule.UserStorage storage $,
// 		address userAddr,
// 		uint256 referrerId
// 	) external returns (uint256 userId, bool isNewUser, bool isRefAdded) {
// 		require(userAddr != address(0), "UserModule: Invalid user address");

// 		User storage user = $.users[userAddr];
// 		userId = user.id;

// 		if (userId != 0) return (userId, false, false);

// 		userId = ++$.userCount;
// 		user.id = userId;
// 		user.addr = userAddr;

// 		if ($.userIdToAddress[referrerId] != address(0)) {
// 			user.referrerId = referrerId;
// 			$.users[$.userIdToAddress[referrerId]].referrals.push(userId);
// 			isRefAdded = true;

// 			emit UserModule.ReferralAdded(referrerId, userId);
// 		}
// 		$.userIdToAddress[userId] = userAddr;

// 		isNewUser = true;
// 		emit UserModule.UserRegistered(
// 			userId,
// 			userAddr,
// 			isRefAdded ? referrerId : 0
// 		);
// 	}
// }

/// @title UserModule
/// @notice Abstract contract for managing user registration and referral tracking.
abstract contract UserModule {
	/// @notice Event emitted when a new user registers.
	event UserRegistered(
		uint256 indexed userId,
		address indexed userAddress,
		uint256 indexed referrerId
	);

	/// @notice Event emitted when a referral is added.
	event ReferralAdded(uint256 indexed referrerId, uint256 indexed referralId);

	/// @custom:storage-location erc7201:userModule.storage
	struct UserStorage {
		uint256 userCount; // Counter for user IDs
		mapping(address => User) users; // Mapping of user address to user data
		mapping(uint256 => address) userIdToAddress; // Mapping of user ID to address
	}
	// keccak256(abi.encode(uint256(keccak256("userModule.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant USER_STORAGE_LOCATION =
		0x0038ec5cf8f0d1747ebb72ff0e651cf1b10ea4f74874fe0bde352ae49428c500;

	/// @notice Internal function to retrieve the storage struct.
	/// @return $ The storage struct containing user data.
	function _getUserStorage() private pure returns (UserStorage storage $) {
		assembly {
			$.slot := USER_STORAGE_LOCATION
		}
	}

	// /// @notice Internal function to register or retrieve a user ID.
	// /// @param userAddr The address of the user.
	// /// @param referrerId The ID of the referrer.
	// /// @return userId The unique ID assigned to the user.
	// function _createOrGetUserId(
	// 	address userAddr,
	// 	uint256 referrerId
	// ) internal returns (uint256 userId) {
	// 	(userId, , ) = UserModuleLib.createOrGetUserId(
	// 		_getUserStorage(),
	// 		userAddr,
	// 		referrerId
	// 	);
	// }

	// /// @notice Retrieves the user ID for a given address.
	// function getUserId(address userAddress) external view returns (uint256) {
	// 	return _getUserStorage().users[userAddress].id;
	// }

	// /// @notice Retrieves the address of a user given their ID.
	// function userIdToAddress(uint256 id) public view returns (address) {
	// 	return _getUserStorage().userIdToAddress[id];
	// }

	// /// @notice Returns the total number of registered users.
	// function totalUsers() external view returns (uint256) {
	// 	return _getUserStorage().userCount;
	// }

	// function getReferrer(
	// 	address userAddress
	// ) public view returns (uint256 referrerId, address referrerAddress) {
	// 	(referrerId, referrerAddress) = UserModuleLib.getReferrer(
	// 		_getUserStorage(),
	// 		userAddress
	// 	);
	// }

	// /// @notice Retrieves the referrals of a user.
	// function getReferrals(
	// 	address userAddress
	// ) external view returns (ReferralInfo[] memory) {
	// 	return UserModuleLib.getReferrals(_getUserStorage(), userAddress);
	// }
}
