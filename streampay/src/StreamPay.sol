// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal ERC-20 surface used by StreamPay (Arc USDC is ERC-20 + the gas token).
interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @dev Single-slot reentrancy guard (no external dependency).
abstract contract ReentrancyGuard {
    uint256 private _status;

    constructor() {
        _status = 1;
    }

    modifier nonReentrant() {
        require(_status == 1, "REENTRANCY");
        _status = 2;
        _;
        _status = 1;
    }
}

/// @title StreamPay
/// @notice A continuous USDC payment-streaming primitive for Arc. A sender locks USDC and it
///         accrues to a recipient linearly between `start` and `stop`. The recipient can withdraw
///         whatever has streamed so far at any time; either party can cancel, which pays the
///         recipient the streamed-but-unwithdrawn amount and returns the rest to the sender.
///
///         Designed for the Arc "agentic economy": agent salaries, metered subscriptions, vesting,
///         and service retainers — paid in USDC, the chain's native gas asset.
///
///         The contract holds no admin keys, has no owner, and never custodies funds beyond the
///         individual streams. It is a public protocol: anyone can open a stream to anyone.
///
///         Solvency invariant per stream, for all t:
///             withdrawn + recipientBalance(t) + senderBalance(t) == deposit
///
///         Arc notes:
///         - USDC has a 6-decimal ERC-20 interface; all amounts are in micro-USDC. The contract is
///           decimal-agnostic — it only ever moves token units via balanceOf/transfer.
///         - block.timestamp on Arc is not strictly increasing (blocks may share a timestamp). The
///           linear accrual is monotonic and dust-free regardless: equal timestamps stream nothing
///           extra, and floor/remainder split keeps the escrow exactly solvent.
contract StreamPay is ReentrancyGuard {
    enum Status {
        None, // 0 - never created
        Active, // 1 - streaming
        Ended // 2 - fully withdrawn or cancelled; terminal
    }

    struct Stream {
        address sender; // funds the stream; receives the unstreamed remainder on cancel
        address recipient; // accrues funds linearly; withdraws what has streamed
        uint256 deposit; // total micro-USDC locked (actual amount received)
        uint256 withdrawn; // micro-USDC already paid out to the recipient
        uint64 start; // unix seconds; accrual begins at start
        uint64 stop; // unix seconds; deposit fully streamed at stop (stop > start)
        Status status;
    }

    IERC20 public immutable usdc;

    uint256 public nextId = 1;
    mapping(uint256 => Stream) public streams;

    event Created(
        uint256 indexed id,
        address indexed sender,
        address indexed recipient,
        uint256 deposit,
        uint64 start,
        uint64 stop,
        string memo
    );
    event Withdrawn(uint256 indexed id, address indexed recipient, uint256 amount);
    event Cancelled(
        uint256 indexed id, address indexed by, uint256 toRecipient, uint256 toSender
    );

    constructor(IERC20 _usdc) {
        require(address(_usdc) != address(0), "USDC_ZERO");
        usdc = _usdc;
    }

    /// @notice Open a stream of `deposit` USDC to `recipient`, accruing linearly from `start` to
    ///         `stop`. Caller must `approve` this contract for `deposit` on the USDC token first.
    /// @param recipient address that accrues and withdraws the streamed funds.
    /// @param deposit   micro-USDC to lock (must be > 0).
    /// @param start     unix seconds accrual begins (may be now or in the future).
    /// @param stop      unix seconds accrual completes (must be > start).
    /// @param memo      human-readable label (emitted only, not stored on-chain).
    /// @return id       the new stream id.
    function createStream(
        address recipient,
        uint256 deposit,
        uint64 start,
        uint64 stop,
        string calldata memo
    ) external nonReentrant returns (uint256 id) {
        require(recipient != address(0), "RECIPIENT_ZERO");
        require(recipient != address(this), "RECIPIENT_SELF");
        require(deposit > 0, "DEPOSIT_ZERO");
        require(stop > start, "BAD_WINDOW");
        require(stop > block.timestamp, "STOP_PAST");

        id = nextId++;

        // Balance-delta accounting: book what actually arrived (balanceOf delta), not what was
        // asked for, so one stream is never credited more than the escrow actually received.
        // Unit-tested with fee-on-transfer and no-return tokens; the production token is Arc
        // USDC (standard 1:1 ERC-20). Other exotic ERC-20 behaviours are out of scope.
        uint256 balBefore = usdc.balanceOf(address(this));
        _safeTransferFrom(msg.sender, address(this), deposit);
        uint256 received = usdc.balanceOf(address(this)) - balBefore;
        require(received > 0, "NO_FUNDS");

        streams[id] = Stream({
            sender: msg.sender,
            recipient: recipient,
            deposit: received,
            withdrawn: 0,
            start: start,
            stop: stop,
            status: Status.Active
        });

        emit Created(id, msg.sender, recipient, received, start, stop, memo);
    }

    /// @notice Total micro-USDC that has streamed to the recipient by `block.timestamp`
    ///         (inclusive of already-withdrawn funds). 0 before `start`, full `deposit` at/after
    ///         `stop`. Uses floored proportional accrual; the sender keeps the sub-unit dust.
    function streamedTotal(uint256 id) public view returns (uint256) {
        Stream storage s = streams[id];
        if (s.status == Status.None) return 0;
        // Terminal: the stream no longer accrues. `withdrawn` was frozen to the final streamed
        // amount on the last withdraw / on cancel, so report that and stop tracking wall-clock time.
        if (s.status == Status.Ended) return s.withdrawn;
        if (block.timestamp <= s.start) return 0;
        if (block.timestamp >= s.stop) return s.deposit;
        uint256 elapsed = block.timestamp - s.start;
        uint256 duration = uint256(s.stop) - s.start;
        return (s.deposit * elapsed) / duration;
    }

    /// @notice Micro-USDC currently withdrawable by the recipient (streamed minus already taken).
    ///         Always 0 for a terminal (ended/cancelled) stream — the escrow holds nothing for it.
    function recipientBalance(uint256 id) public view returns (uint256) {
        if (streams[id].status != Status.Active) return 0;
        return streamedTotal(id) - streams[id].withdrawn;
    }

    /// @notice Micro-USDC the sender would reclaim on an immediate cancel (the unstreamed part).
    ///         Always 0 for a terminal (ended/cancelled) stream — nothing remains to reclaim.
    function senderBalance(uint256 id) public view returns (uint256) {
        if (streams[id].status != Status.Active) return 0;
        return streams[id].deposit - streamedTotal(id);
    }

    /// @notice Recipient pulls up to `amount` of the streamed-so-far balance. Pass 0 to withdraw
    ///         the full available balance.
    function withdraw(uint256 id, uint256 amount) external nonReentrant {
        Stream storage s = streams[id];
        require(s.status == Status.Active, "NOT_ACTIVE");
        require(msg.sender == s.recipient, "NOT_RECIPIENT");

        uint256 available = streamedTotal(id) - s.withdrawn;
        if (amount == 0) amount = available;
        require(amount > 0, "NOTHING_TO_WITHDRAW");
        require(amount <= available, "EXCEEDS_AVAILABLE");

        s.withdrawn += amount;
        // If everything has streamed and been withdrawn, the stream is terminal.
        if (s.withdrawn == s.deposit) s.status = Status.Ended;

        _safeTransfer(s.recipient, amount);
        emit Withdrawn(id, s.recipient, amount);
    }

    /// @notice Either party may cancel. The recipient is paid the streamed-but-unwithdrawn amount;
    ///         the sender is refunded the rest. Terminal.
    function cancel(uint256 id) external nonReentrant {
        Stream storage s = streams[id];
        require(s.status == Status.Active, "NOT_ACTIVE");
        require(msg.sender == s.sender || msg.sender == s.recipient, "NOT_PARTY");

        uint256 streamed = streamedTotal(id);
        uint256 toRecipient = streamed - s.withdrawn; // unwithdrawn streamed funds
        uint256 toSender = s.deposit - streamed; // unstreamed remainder

        // Mark terminal before any external call (checks-effects-interactions + reentrancy guard).
        s.status = Status.Ended;
        s.withdrawn = streamed;

        if (toRecipient > 0) _safeTransfer(s.recipient, toRecipient);
        if (toSender > 0) _safeTransfer(s.sender, toSender);

        emit Cancelled(id, msg.sender, toRecipient, toSender);
    }

    /// @notice Convenience view returning the full stream record.
    function get(uint256 id) external view returns (Stream memory) {
        return streams[id];
    }

    // --- safe ERC-20 helpers (tolerate non-standard no-return tokens) ---

    function _safeTransfer(address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transfer.selector, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FAILED");
    }

    function _safeTransferFrom(address from, address to, uint256 amount) private {
        (bool ok, bytes memory data) =
            address(usdc).call(abi.encodeWithSelector(IERC20.transferFrom.selector, from, to, amount));
        require(ok && (data.length == 0 || abi.decode(data, (bool))), "TRANSFER_FROM_FAILED");
    }
}
