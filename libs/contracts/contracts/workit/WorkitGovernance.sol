// SPDX-License-Identifier: MIT
pragma solidity ^0.8.28;

import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

import {IWorkitLaunchpad} from "./interfaces/IWorkitLaunchpad.sol";
import {IWorkitStaking} from "./interfaces/IWorkitStaking.sol";
import {IWorkitEmissionManager} from "./interfaces/IWorkitEmissionManager.sol";

contract WorkitGovernance is AccessControl, ReentrancyGuard {
	bytes32 public constant PROPOSER_ROLE = keccak256("PROPOSER_ROLE");

	enum ProposalType {
		FinalizeCampaign,
		SetPoolEmission,
		SetQuoteToken,
		SetTreasury
	}

	struct Proposal {
		ProposalType proposalType;
		uint64 startTime;
		uint64 endTime;
		uint256 forVotes;
		uint256 againstVotes;
		bool executed;
		uint256 campaignId;
		uint256 workitMin;
		uint256 quoteMin;
		address pool;
		uint256 emissionWeight;
		address quoteToken;
		bool quoteTokenAllowed;
		address treasury;
	}

	IERC20 public immutable workit;
	IWorkitLaunchpad public immutable launchpad;
	IWorkitStaking public immutable staking;
	IWorkitEmissionManager public immutable emissionManager;

	uint256 public votingPeriod;
	uint256 public proposalCount;

	mapping(uint256 => Proposal) private _proposals;
	mapping(uint256 => mapping(address => bool)) public hasVoted;

	event VotingPeriodUpdated(uint256 previousVotingPeriod, uint256 votingPeriod);
	event ProposalCreated(
		uint256 indexed proposalId,
		ProposalType indexed proposalType,
		uint64 startTime,
		uint64 endTime,
		bytes32 metadataHash
	);
	event VoteCast(
		uint256 indexed proposalId,
		address indexed voter,
		bool support,
		uint256 weight
	);
	event ProposalExecuted(
		uint256 indexed proposalId,
		ProposalType indexed proposalType,
		address indexed executor
	);

	error ZeroAddress();
	error InvalidVotingPeriod(uint256 votingPeriod);
	error InvalidProposal(uint256 proposalId);
	error ProposalInactive(
		uint256 proposalId,
		uint256 startTime,
		uint256 endTime,
		uint256 currentTime
	);
	error ProposalNotEnded(uint256 proposalId, uint256 endTime, uint256 currentTime);
	error ProposalAlreadyExecuted(uint256 proposalId);
	error AlreadyVoted(uint256 proposalId, address voter);
	error NoVotingPower(address voter);
	error ProposalRejected(uint256 proposalId, uint256 forVotes, uint256 againstVotes);

	constructor(
		address admin,
		address workit_,
		address launchpad_,
		address staking_,
		address emissionManager_,
		uint256 votingPeriod_
	) {
		if (
			admin == address(0) ||
			workit_ == address(0) ||
			launchpad_ == address(0) ||
			staking_ == address(0) ||
			emissionManager_ == address(0)
		) {
			revert ZeroAddress();
		}
		if (votingPeriod_ == 0) revert InvalidVotingPeriod(votingPeriod_);

		workit = IERC20(workit_);
		launchpad = IWorkitLaunchpad(launchpad_);
		staking = IWorkitStaking(staking_);
		emissionManager = IWorkitEmissionManager(emissionManager_);
		votingPeriod = votingPeriod_;

		_grantRole(DEFAULT_ADMIN_ROLE, admin);
		_grantRole(PROPOSER_ROLE, admin);
	}

	function setVotingPeriod(
		uint256 votingPeriod_
	) external onlyRole(DEFAULT_ADMIN_ROLE) {
		if (votingPeriod_ == 0) revert InvalidVotingPeriod(votingPeriod_);

		uint256 previousVotingPeriod = votingPeriod;
		votingPeriod = votingPeriod_;

		emit VotingPeriodUpdated(previousVotingPeriod, votingPeriod_);
	}

	function proposeCampaignFinalization(
		uint256 campaignId,
		uint256 workitMin,
		uint256 quoteMin,
		bytes32 metadataHash
	) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
		proposalId = _createProposal(ProposalType.FinalizeCampaign, metadataHash);
		Proposal storage proposal = _proposals[proposalId];
		proposal.campaignId = campaignId;
		proposal.workitMin = workitMin;
		proposal.quoteMin = quoteMin;
	}

	function proposePoolEmissionWeight(
		address pool,
		uint256 emissionWeight,
		bytes32 metadataHash
	) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
		if (pool == address(0)) revert ZeroAddress();

		proposalId = _createProposal(ProposalType.SetPoolEmission, metadataHash);
		Proposal storage proposal = _proposals[proposalId];
		proposal.pool = pool;
		proposal.emissionWeight = emissionWeight;
	}

	function proposeQuoteTokenApproval(
		address quoteToken,
		bool allowed,
		bytes32 metadataHash
	) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
		if (quoteToken == address(0)) revert ZeroAddress();

		proposalId = _createProposal(ProposalType.SetQuoteToken, metadataHash);
		Proposal storage proposal = _proposals[proposalId];
		proposal.quoteToken = quoteToken;
		proposal.quoteTokenAllowed = allowed;
	}

	function proposeTreasuryUpdate(
		address treasury,
		bytes32 metadataHash
	) external onlyRole(PROPOSER_ROLE) returns (uint256 proposalId) {
		if (treasury == address(0)) revert ZeroAddress();

		proposalId = _createProposal(ProposalType.SetTreasury, metadataHash);
		Proposal storage proposal = _proposals[proposalId];
		proposal.treasury = treasury;
	}

	function vote(uint256 proposalId, bool support) external {
		Proposal storage proposal = _proposal(proposalId);
		if (
			block.timestamp < proposal.startTime ||
			block.timestamp > proposal.endTime
		) {
			revert ProposalInactive(
				proposalId,
				proposal.startTime,
				proposal.endTime,
				block.timestamp
			);
		}
		if (hasVoted[proposalId][msg.sender]) {
			revert AlreadyVoted(proposalId, msg.sender);
		}

		uint256 votingWeight = workit.balanceOf(msg.sender);
		if (votingWeight == 0) revert NoVotingPower(msg.sender);

		hasVoted[proposalId][msg.sender] = true;
		if (support) {
			proposal.forVotes += votingWeight;
		} else {
			proposal.againstVotes += votingWeight;
		}

		emit VoteCast(proposalId, msg.sender, support, votingWeight);
	}

	function execute(uint256 proposalId) external nonReentrant {
		Proposal storage proposal = _proposal(proposalId);
		if (proposal.executed) revert ProposalAlreadyExecuted(proposalId);
		if (block.timestamp <= proposal.endTime) {
			revert ProposalNotEnded(proposalId, proposal.endTime, block.timestamp);
		}
		if (proposal.forVotes <= proposal.againstVotes) {
			revert ProposalRejected(
				proposalId,
				proposal.forVotes,
				proposal.againstVotes
			);
		}

		proposal.executed = true;

		if (proposal.proposalType == ProposalType.FinalizeCampaign) {
			launchpad.governanceFinalizeCampaign(
				proposal.campaignId,
				proposal.workitMin,
				proposal.quoteMin
			);
		} else if (proposal.proposalType == ProposalType.SetPoolEmission) {
			staking.setPoolEmissionWeight(proposal.pool, proposal.emissionWeight);
		} else if (proposal.proposalType == ProposalType.SetQuoteToken) {
			launchpad.setQuoteTokenAllowed(
				proposal.quoteToken,
				proposal.quoteTokenAllowed
			);
		} else {
			emissionManager.setTreasury(proposal.treasury);
		}

		emit ProposalExecuted(proposalId, proposal.proposalType, msg.sender);
	}

	function _createProposal(
		ProposalType proposalType,
		bytes32 metadataHash
	) private returns (uint256 proposalId) {
		proposalId = ++proposalCount;

		uint64 startTime = uint64(block.timestamp);
		uint64 endTime = uint64(block.timestamp + votingPeriod);

		Proposal storage proposal = _proposals[proposalId];
		proposal.proposalType = proposalType;
		proposal.startTime = startTime;
		proposal.endTime = endTime;

		emit ProposalCreated(
			proposalId,
			proposalType,
			startTime,
			endTime,
			metadataHash
		);
	}

	function _proposal(
		uint256 proposalId
	) private view returns (Proposal storage proposal) {
		proposal = _proposals[proposalId];
		if (proposal.startTime == 0) revert InvalidProposal(proposalId);
	}

	function getProposal(
		uint256 proposalId
	) external view returns (Proposal memory) {
		Proposal storage proposal = _proposal(proposalId);
		return proposal;
	}
}
