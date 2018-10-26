import * as Base58 from 'bs58';
import Multihash from './Multihash';
import Transaction from './Transaction';
import { Cas } from './Cas';
import { DidDocument } from '@decentralized-identity/did-common-typescript';
import { didDocumentCreate, didDocumentUpdate } from '../tests/mocks/MockDidDocumentGenerator';
import { WriteOperation, OperationType } from './Operation';

/**
 * VersionId identifies the version of a DID document. We use the hash of the
 * operation that produces a particular version of a DID document as its versionId.
 * This usage is guaranteed to produce unique VersionId's since the operation contains
 * as one of its properties the previous VersionId. Since the operation hash is
 * just a string we alias VersionId to string.
 *
 * With this usage, the operation hash serves two roles (1) an identifier for an operation
 * (2) an identifier for the DID document produced by the operation. In the code below,
 * we always use VersionId in places where we mean (2) and an OperationHash defined below
 * when we mean (1).
 */
export type VersionId = string;

/**
 * Alias OperationHash to string - see comment above
 */
export type OperationHash = string;

/**
 * Represents the interface used by other components to update and retrieve the
 * current state of a Sidetree node. The interface exposes methods to record
 * sidetree DID state changes (create, update, delete, recover)
 * and methods to retrieve current and historical states of a DID document.
 */
export interface DidCache {
  /** The transaction that was COMPLETELY processed. */
  readonly lastProcessedTransaction?: Transaction;

  /**
   * Applies the given DID operation to the DID Cache.
   * @returns An identifier that can be used to retrieve
   * the DID document version produced by the operation
   * and to traverse the version chain using the
   * first/last/prev/next methods below. If the write
   * operation is not legitimate return undefined.
   */
  apply (operation: WriteOperation): string | undefined;

  /**
   * Rollback the state of the DidCache by removing all operations
   * with transactionNumber greater than the provided parameter value.
   * The intended use case for this method is to handle rollbacks
   * in the blockchain.
   */
  rollback (transactionNumber: number): void;

  /**
   * Resolve a did.
   */
  resolve (did: VersionId): Promise<DidDocument | undefined>;

  /**
   * Returns the Did document for a given version identifier.
   */
  lookup (versionId: VersionId): Promise<DidDocument | undefined>;

  /**
   * Return the first (initial) version identifier given
   * version identifier, which is also the DID for the
   * document corresponding to the versions. Return undefined
   * if the version id or some previous version in the chain
   * is unknown.
   */
  first (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the last (latest/most recent) version identifier of
   * a given version identifier. Return undefined if the version
   * identifier is unknown or some successor identifier is unknown.
   */
  last (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the previous version identifier of a given DID version
   * identifier. Return undefined if no such identifier is known.
   */
  prev (versionId: VersionId): Promise<VersionId | undefined>;

  /**
   * Return the next version identifier of a given DID version
   * identifier. Return undefined if no such identifier is known.
   */
  next (versionId: VersionId): Promise<VersionId | undefined>;
}

/**
 * The timestamp of an operation. We define a linear ordering of
 * timestamps using the function lesser below.
 */
interface OperationTimestamp {
  readonly transactionNumber: number;
  readonly operationIndex: number;
}

function earlier (ts1: OperationTimestamp, ts2: OperationTimestamp): boolean {
  return ((ts1.transactionNumber < ts2.transactionNumber) ||
          (ts1.transactionNumber === ts2.transactionNumber) && (ts1.operationIndex < ts2.operationIndex));
}

/**
 * Information about a write operation relevant for the DID cache, a subset of the properties exposed by
 * WriteOperation.
 */
interface OperationInfo extends OperationTimestamp {
  readonly batchFileHash: string;
  readonly type: OperationType;
}

/**
 * The current implementation is a main-memory implementation without any persistence. This
 * means that when a node is powered down and restarted DID operations need to be applied
 * from the beginning of time. This implementation will be extended in the future to support
 * persistence.
 */
class DidCacheImpl implements DidCache {
  /**
   * Map a versionId to the next versionId whenever one exists.
   */
  private nextVersion: Map<VersionId, VersionId> = new Map();

  /**
   * Map a operation hash to the OperationInfo which contains sufficient
   * information to reconstruct the operation.
   */
  private opHashToInfo: Map<OperationHash, OperationInfo> = new Map();

  public constructor (private readonly cas: Cas) {

  }

  /**
   * Apply (perform) a specified DID state changing operation.
   */
  public apply (operation: WriteOperation): string | undefined {
    const opHash = DidCacheImpl.getHash(operation);

    // Ignore operations without the required metadata - any operation anchored
    // in a blockchain should have this metadata.
    if (operation.transactionNumber === undefined) {
      throw Error('Invalid operation: transactionNumber undefined');
    }

    if (operation.operationIndex === undefined) {
      throw Error('Invalid operation: operationIndex undefined');
    }

    if(operation.batchFileHash === undefined) {
      throw Error('Invalid operation: batchFileHash undefined');
    }

    // opInfo is operation with derivable properties projected out
    const opInfo: OperationInfo = {
      transactionNumber: operation.transactionNumber,
      operationIndex: operation.operationIndex,
      batchFileHash: operation.batchFileHash,
      type: operation.type
    };

    // If this is a duplicate of an earlier operation, we can
    // ignore this operation. Note that we might have a previous
    // operation with the same hash, but that previous operation
    // need not be earlier in timestamp order - hence the check
    // with lesser().
    const prevOperation = this.opHashToInfo.get(opHash);
    if (prevOperation !== undefined && earlier(prevOperation, opInfo)) {
      return undefined;
    }
    // Update our mapping of operation hash to operation info overwriting
    // previous info if it exists
    this.opHashToInfo.set(opHash, opInfo);

    // For operations that have a previous version, we need additional
    // bookkeeping
    if (operation.previousOperationHash) {
      this.applyOpWithPrev(opHash, opInfo, operation.previousOperationHash);
    }

    return opHash;
  }

  /**
   * Rollback the state of the DidCache by removing all operations
   * with transactionNumber greater than the provided parameter value.
   * The intended use case for this method is to handle rollbacks
   * in the blockchain.
   *
   * The current implementation is inefficient: It simply scans the two
   * hashmaps storing the core Did state and removes all entries with
   * a greater transaction number.  In future, the implementation should be optimized
   * for the common case by keeping a sliding window of recent operations.
   */
  public rollback (transactionNumber: number) {

    // Iterate over all nextVersion entries and remove all versions
    // with "next" operation with transactionNumber greater than the provided
    // parameter.
    this.nextVersion.forEach((opHash, version, map) => {
      const opInfo = this.opHashToInfo.get(opHash) as OperationInfo;
      if (opInfo.transactionNumber > transactionNumber) {
        map.delete(version);
      }
    });

    // Iterate over all operations and remove those with with
    // transactionNumber greater than the provided parameter.
    this.opHashToInfo.forEach((opInfo, opHash, map) => {
      if (opInfo.transactionNumber > transactionNumber) {
        map.delete(opHash);
      }
    });
  }

  /**
   * Resolve a did.
   */
  public async resolve (did: VersionId): Promise<DidDocument | undefined> {
    const latestVersion = await this.last(did);

    // lastVersion === null implies we do not know about the did
    if (latestVersion === undefined) {
      return undefined;
    }

    return this.lookup(latestVersion);
  }

  /**
   * Returns the Did document for a given version identifier.
   */
  public async lookup (versionId: VersionId): Promise<DidDocument | undefined> {
    // Version id is also the operation hash that produces the document
    const opHash = versionId;

    const opInfo = this.opHashToInfo.get(opHash);

    // We don't know anything about this operation
    if (opInfo === undefined) {
      return undefined;
    }

    // Construct the operation using a CAS lookup
    const op = await this.getOperation(opInfo);

    if (this.isInitialVersion(opInfo)) {
      return didDocumentCreate(op);
    } else {
      const prevVersion = op.previousOperationHash as VersionId;
      const prevDidDoc = await this.lookup(prevVersion);
      if (prevDidDoc === undefined) {
        return undefined;
      } else {
        return didDocumentUpdate(prevDidDoc, op);
      }
    }
  }

  /**
   * Return the previous version id of a given DID version. The implementation
   * is inefficient and involves an async cas read. This should not be a problem
   * since this method is not hit for any of the externally exposed DID operations.
   */
  public async prev (versionId: VersionId): Promise<VersionId | undefined> {
    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo) {
      const op = await this.getOperation(opInfo);
      if (op.previousOperationHash) {
        return op.previousOperationHash;
      }
    }
    return undefined;
  }

  /**
   * Return the first version of a DID document given a possibly later version.
   * A simple recursive implementation using prev; not very efficient but should
   * not matter since this method is not hit for any externally exposed DID
   * operations.
   */
  public async first (versionId: VersionId): Promise<VersionId | undefined> {
    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo === undefined) {
      return undefined;
    }

    if (this.isInitialVersion(opInfo)) {
      return versionId;
    }

    const prevVersionId = await this.prev(versionId);
    if (prevVersionId === undefined) {
      return undefined;
    }

    return this.first(prevVersionId);
  }

  /**
   * Return the next version of a DID document if it exists or null, otherwise.
   */
  public async next (versionId: VersionId): Promise<VersionId | undefined> {
    const nextVersionId = this.nextVersion.get(versionId);
    if (nextVersionId === undefined) {
      return undefined;
    } else {
      return nextVersionId;
    }
  }

  /**
   * Return the latest (most recent) version of a DID document. Return null if
   * the version is unknown.
   */
  public async last (versionId: VersionId): Promise<VersionId | undefined> {
    const opInfo = this.opHashToInfo.get(versionId);
    if (opInfo === undefined) {
      return undefined;
    }

    const nextVersionId = await this.next(versionId);
    if (nextVersionId === undefined) {
      return versionId;
    } else {
      return this.last(nextVersionId);
    }
  }

  /**
   * Get the last processed transaction.
   * TODO: fix this after discussing the intended semantics.
   */
  public get lastProcessedTransaction (): Transaction | undefined {
    return undefined;
  }

  /**
   * Get a cryptographic hash of the write operation. Currently, uses
   * SHA256 to get hashes (TODO: Fix it to be consistent DID generation)
   */
  private static getHash (operation: WriteOperation): OperationHash {
    const sha256HashCode = 18;
    const multihash = Multihash.hash(operation.operationBuffer, sha256HashCode);
    const multihashBase58 = Base58.encode(multihash);
    return multihashBase58;
  }

  /**
   * Apply state changes for operations that have a previous version (update, delete, recover)
   */
  private applyOpWithPrev (opHash: OperationHash, opInfo: OperationInfo, version: VersionId): void {
    // We might already know of an update to this version. If so, we retain
    // the older of previously known update and the current one
    const prevUpdateHash = this.nextVersion.get(version);
    if (prevUpdateHash !== undefined) {
      const prevUpdateInfo = this.opHashToInfo.get(prevUpdateHash) as OperationInfo;
      if (earlier(prevUpdateInfo, opInfo)) {
        return;
      }
    }

    this.nextVersion.set(version, opHash);
  }

  /**
   * Return true if the provided operation is an initial version i.e.,
   * produced by a create operation.
   */
  private isInitialVersion (opInfo: OperationInfo): boolean {
    return opInfo.type === OperationType.Create;
  }

  /**
   * Return the operation given its (access) info.
   */
  private async getOperation (opInfo: OperationInfo): Promise<WriteOperation> {
    const batchBuffer = await this.cas.read(opInfo.batchFileHash);
    const batch = JSON.parse(batchBuffer.toString());
    const opBuffer = Buffer.from(batch[opInfo.operationIndex].data);
    return WriteOperation.create(opBuffer, opInfo.batchFileHash, opInfo.transactionNumber, opInfo.operationIndex);
  }
}

/**
 * Factory function for creating a Did cache
 */
export function createDidCache (cas: Cas): DidCache {
  return new DidCacheImpl(cas);
}
