// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Minimal voting-power adapter for non-ERC20 governance weight sources.
interface IVotingPowerSource {
	function votingPower(address account) external view returns (uint256);
}

/// @title WorkitGovernance
/// @notice Proposal-based governance for pools, emissions, launch params, and reward policy.
contract WorkitGovernance is AccessControl {
	bytes32 public constant GOVERNANCE_ADMIN_ROLE =
		keccak256("GOVERNANCE_ADMIN_ROLE");

	enum VotingPowerMode {
		ERC20_BALANCE,
		EXTERNAL_SOURCE
	}

	struct Proposal {
		address proposer;
		address target;
		uint256 value;
		bytes data;
		bytes32 descriptionHash;
		uint256 startBlock;
		uint256 endBlock;
		uint256 forVotes;
		uint256 againstVotes;
		bool executed;
		bool canceled;
	}

	VotingPowerMode public votingPowerMode;
	address public votingPowerSource;
	uint256 public votingDelayBlocks;
	uint256 public votingPeriodBlocks;
	uint256 public proposalThreshold;
	uint256 public quorumVotes;

	uint256 public proposalCount;
	mapping(uint256 => Proposal) public proposals;
	mapping(uint256 => mapping(address => bool)) public hasVoted;

	error ZeroAddress();
	error InvalidVotingConfig();
	error ProposalNotFound(uint256 proposalId);
	error ProposalNotActive(uint256 proposalId);
	error ProposalNotQueuedForExecution(uint256 proposalId);
	error AlreadyVoted(uint256 proposalId, address voter);
	error InsufficientProposalPower(uint256 required, uint256 actual);
	error ExecutionFailed(bytes revertData);

	event ProposalCreated(
		uint256 indexed proposalId,
		address indexed proposer,
		address indexed target,
		uint256 value,
		bytes32 descriptionHash,
		uint256 startBlock,
		uint256 endBlock
	);
	event VoteCast(
		uint256 indexed proposalId,
		address indexed voter,
		bool support,
		uint256 weight
	);
	event ProposalExecuted(uint256 indexed proposalId);
	event ProposalCanceled(uint256 indexed proposalId);
	event VotingConfigUpdated(
		uint256 votingDelayBlocks,
		uint256 votingPeriodBlocks,
		uint256 proposalThreshold,
		uint256 quorumVotes
	);
	event VotingPowerSourceUpdated(
		VotingPowerMode mode,
		address indexed votingPowerSource
	);

	constructor(
		address admin,
		address votingPowerSource_,
		VotingPowerMode mode,
		uint256 votingDelayBlocks_,
		uint256 votingPeriodBlocks_,
		uint256 proposalThreshold_,
		uint256 quorumVotes_
	) {
		if (admin == address(0) || votingPowerSource_ == address(0)) {
			revert ZeroAddress();
		}
		if (votingPeriodBlocks_ == 0) revert InvalidVotingConfig();

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(GOVERNANCE_ADMIN_ROLE, admin);

		votingPowerMode = mode;
		votingPowerSource = votingPowerSource_;
		votingDelayBlocks = votingDelayBlocks_;
		votingPeriodBlocks = votingPeriodBlocks_;
		proposalThreshold = proposalThreshold_;
		quorumVotes = quorumVotes_;
	}

	/// @notice Creates a new governance proposal.
	function propose(
		address target,
		uint256 value,
		bytes calldata data,
		string calldata description
	) external returns (uint256 proposalId) {
		if (target == address(0)) revert ZeroAddress();

		uint256 votingPower = _votingPower(msg.sender);
		if (votingPower < proposalThreshold) {
			revert InsufficientProposalPower(proposalThreshold, votingPower);
		}

		proposalId = ++proposalCount;
		uint256 startBlock = block.number + votingDelayBlocks;
		uint256 endBlock = startBlock + votingPeriodBlocks;
		bytes32 descriptionHash = keccak256(bytes(description));

		proposals[proposalId] = Proposal({
			proposer: msg.sender,
			target: target,
			value: value,
			data: data,
			descriptionHash: descriptionHash,
			startBlock: startBlock,
			endBlock: endBlock,
			forVotes: 0,
			againstVotes: 0,
			executed: false,
			canceled: false
		});

		emit ProposalCreated(
			proposalId,
			msg.sender,
			target,
			value,
			descriptionHash,
			startBlock,
			endBlock
		);
	}

	/// @notice Casts a vote for or against an active proposal.
	function vote(uint256 proposalId, bool support) external {
		Proposal storage proposal = _requireProposal(proposalId);
		if (!_isProposalActive(proposal)) revert ProposalNotActive(proposalId);
		if (hasVoted[proposalId][msg.sender]) {
			revert AlreadyVoted(proposalId, msg.sender);
		}

		hasVoted[proposalId][msg.sender] = true;
		uint256 weight = _votingPower(msg.sender);

		if (support) proposal.forVotes += weight;
		else proposal.againstVotes += weight;

		emit VoteCast(proposalId, msg.sender, support, weight);
	}

	/// @notice Executes a successful proposal.
	function execute(uint256 proposalId) external payable {
		Proposal storage proposal = _requireProposal(proposalId);
		if (!_isProposalExecutable(proposal)) {
			revert ProposalNotQueuedForExecution(proposalId);
		}

		proposal.executed = true;
		(bool success, bytes memory data) = proposal.target.call{value: proposal.value}(
			proposal.data
		);
		if (!success) revert ExecutionFailed(data);

		emit ProposalExecuted(proposalId);
	}

	/// @notice Cancels a non-executed proposal.
	function cancel(uint256 proposalId) external onlyRole(GOVERNANCE_ADMIN_ROLE) {
		Proposal storage proposal = _requireProposal(proposalId);
		proposal.canceled = true;
		emit ProposalCanceled(proposalId);
	}

	function setVotingConfig(
		uint256 votingDelayBlocks_,
		uint256 votingPeriodBlocks_,
		uint256 proposalThreshold_,
		uint256 quorumVotes_
	) external onlyRole(GOVERNANCE_ADMIN_ROLE) {
		if (votingPeriodBlocks_ == 0) revert InvalidVotingConfig();

		votingDelayBlocks = votingDelayBlocks_;
		votingPeriodBlocks = votingPeriodBlocks_;
		proposalThreshold = proposalThreshold_;
		quorumVotes = quorumVotes_;

		emit VotingConfigUpdated(
			votingDelayBlocks_,
			votingPeriodBlocks_,
			proposalThreshold_,
			quorumVotes_
		);
	}

	/// @notice Switches voting power source (WORKIT ERC20 or adapter such as GToken-weight source).
	function setVotingPowerSource(
		VotingPowerMode mode,
		address source
	) external onlyRole(GOVERNANCE_ADMIN_ROLE) {
		if (source == address(0)) revert ZeroAddress();
		votingPowerMode = mode;
		votingPowerSource = source;
		emit VotingPowerSourceUpdated(mode, source);
	}

	function state(
		uint256 proposalId
	)
		external
		view
		returns (
			bool active,
			bool succeeded,
			bool executed,
			bool canceled
		)
	{
		Proposal storage proposal = _requireProposal(proposalId);
		active = _isProposalActive(proposal);
		succeeded = _isProposalSucceeded(proposal);
		executed = proposal.executed;
		canceled = proposal.canceled;
	}

	function _isProposalActive(Proposal storage proposal) internal view returns (bool) {
		return
			!proposal.executed &&
			!proposal.canceled &&
			block.number >= proposal.startBlock &&
			block.number <= proposal.endBlock;
	}

	function _isProposalSucceeded(
		Proposal storage proposal
	) internal view returns (bool) {
		if (proposal.executed || proposal.canceled) return false;
		if (block.number <= proposal.endBlock) return false;
		if (proposal.forVotes <= proposal.againstVotes) return false;
		return proposal.forVotes >= quorumVotes;
	}

	function _isProposalExecutable(
		Proposal storage proposal
	) internal view returns (bool) {
		return _isProposalSucceeded(proposal) && !proposal.executed;
	}

	function _votingPower(address voter) internal view returns (uint256) {
		if (votingPowerMode == VotingPowerMode.ERC20_BALANCE) {
			return IERC20(votingPowerSource).balanceOf(voter);
		}
		return IVotingPowerSource(votingPowerSource).votingPower(voter);
	}

	function _requireProposal(
		uint256 proposalId
	) internal view returns (Proposal storage proposal) {
		proposal = proposals[proposalId];
		if (proposal.proposer == address(0)) revert ProposalNotFound(proposalId);
	}
}
