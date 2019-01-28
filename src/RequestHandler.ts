import * as Ipfs from 'ipfs';
import base64url from 'base64url';
import { IpfsStorage } from './lib/IpfsStorage';
import { Response, ResponseStatus } from './Response';
import { Timeout } from './lib/Timeout';
const multihashes = require('multihashes');

/**
 * Sidetree IPFS request handler class
 */
export default class RequestHandler {

  /**
   * Instance of IpfsStorage.
   */
  public ipfsStorage: IpfsStorage;

  public constructor (ipfsOptions: Ipfs.Options) {
    this.ipfsStorage = IpfsStorage.create(ipfsOptions);
  }
  /**
   * Handles read request
   * @param base64urlEncodedMultihash Content Identifier Hash.
   */
  public async handleFetchRequest (base64urlEncodedMultihash: string): Promise<Response> {
    const multihashBuffer = base64url.toBuffer(base64urlEncodedMultihash);
    let response: Response;
    try {
      multihashes.validate(multihashBuffer);
    } catch {
      return {
        status: ResponseStatus.BadRequest,
        body: { error: 'Invalid content Hash' }
      };
    }
    try {
      const base58EncodedMultihashString = multihashes.toB58String(multihashBuffer);
      const fetchPromsie = this.ipfsStorage.read(base58EncodedMultihashString);

      // TODO: Move fetch timeout into a configurable config file - https://github.com/decentralized-identity/sidetree-ipfs/issues/28
      const timeoutInMilliseconds = 10000;
      const result = await Timeout.timeout(fetchPromsie, timeoutInMilliseconds);

      if (result instanceof Error) {
        response = {
          status: ResponseStatus.NotFound
        };
      } else {
        response = {
          status: ResponseStatus.Succeeded,
          body: result
        };
      }
    } catch (err) {
      response = {
        status: ResponseStatus.ServerError,
        body: err.message
      };
    }
    return response;
  }

  /**
   * Handles sidetree content write request
   * @param content Sidetree content to write into CAS storage
   */
  public async handleWriteRequest (content: Buffer): Promise<Response> {
    let response: Response;
    try {
      const base58EncodedMultihashString = await this.ipfsStorage.write(content);
      const multihashBuffer = multihashes.fromB58String(base58EncodedMultihashString);
      const base64urlEncodedMultihash = base64url.encode(multihashBuffer);
      response = {
        status: ResponseStatus.Succeeded,
        body: { hash: base64urlEncodedMultihash }
      };
    } catch (err) {
      response = {
        status: ResponseStatus.ServerError,
        body: err.message
      };
    }
    return response;
  }
}
