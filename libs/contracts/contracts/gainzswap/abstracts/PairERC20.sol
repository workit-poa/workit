// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";

abstract contract PairERC20 is Initializable, IERC20, IERC20Errors {
	string public constant name = "GainzLP";
	string public constant symbol = "GNZ-LP";
	uint8 public constant decimals = 18;

	/// @custom:storage-location erc7201:gainz.PairERC20.storage
	struct PairERC20Storage {
		uint totalSupply;
		mapping(address => uint) balanceOf;
		mapping(address => mapping(address => uint)) allowance;
		bytes32 domainSeperator;
	}
	// keccak256(abi.encode(uint256(keccak256("gainz.PairERC20.storage")) - 1)) & ~bytes32(uint256(0xff));
	bytes32 private constant PAIR_ERC20_STORAGE_LOCATION =
		0x0053e124b05349f2255dde42e8688e7f08d28e98ecf44867b1f7ffaee445dc00;

	function _getPairERC20Storage()
		private
		pure
		returns (PairERC20Storage storage $)
	{
		assembly {
			$.slot := PAIR_ERC20_STORAGE_LOCATION
		}
	}

	function DOMAIN_SEPARATOR() public view returns (bytes32) {
		return _getPairERC20Storage().domainSeperator;
	}

	// keccak256("Permit(address owner,address spender,uint256 value,uint256 nonce,uint256 deadline)");
	bytes32 public constant PERMIT_TYPEHASH =
		0x6e71edae12b1b97f4d1f60370fef10105fa2faae0126114a169c64845d6126c9;
	mapping(address => uint) public nonces;

	// called once by the Router at time of deployment
	function __PairERC20_init() internal onlyInitializing {
		PairERC20Storage storage $ = _getPairERC20Storage();

		uint chainId;
		assembly {
			chainId := chainid()
		}
		$.domainSeperator = keccak256(
			abi.encode(
				keccak256(
					"EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
				),
				keccak256(bytes(name)),
				keccak256(bytes("1")),
				chainId,
				address(this)
			)
		);
	}

	function _mint(address to, uint value) internal {
		PairERC20Storage storage $ = _getPairERC20Storage();

		$.totalSupply += (value);
		$.balanceOf[to] += (value);
		emit Transfer(address(0), to, value);
	}

	function _burn(address from, uint value) internal {
		PairERC20Storage storage $ = _getPairERC20Storage();

		$.balanceOf[from] -= (value);
		$.totalSupply -= (value);
		emit Transfer(from, address(0), value);
	}

	function _approve(address owner, address spender, uint value) private {
		PairERC20Storage storage $ = _getPairERC20Storage();
		$.allowance[owner][spender] = value;
		emit Approval(owner, spender, value);
	}

	function _transfer(address from, address to, uint value) private {
		PairERC20Storage storage $ = _getPairERC20Storage();
		$.balanceOf[from] -= (value);
		$.balanceOf[to] += (value);
		emit Transfer(from, to, value);
	}

	function approve(address spender, uint value) external returns (bool) {
		_approve(msg.sender, spender, value);
		return true;
	}

	function transfer(address to, uint value) external returns (bool) {
		_transfer(msg.sender, to, value);
		return true;
	}

	function transferFrom(
		address from,
		address to,
		uint value
	) external returns (bool) {
		PairERC20Storage storage $ = _getPairERC20Storage();

		uint256 currentAllowance = $.allowance[from][msg.sender];
		if (currentAllowance < value) {
			revert ERC20InsufficientAllowance(
				msg.sender,
				currentAllowance,
				value
			);
		}

		$.allowance[from][msg.sender] -= (value);

		_transfer(from, to, value);
		return true;
	}

	function totalSupply() public view override returns (uint256) {
		PairERC20Storage storage $ = _getPairERC20Storage();

		return $.totalSupply;
	}

	function balanceOf(address account) public view override returns (uint256) {
		PairERC20Storage storage $ = _getPairERC20Storage();

		return $.balanceOf[account];
	}

	function allowance(
		address owner,
		address spender
	) public view virtual returns (uint256) {
		PairERC20Storage storage $ = _getPairERC20Storage();

		return $.allowance[owner][spender];
	}
}
