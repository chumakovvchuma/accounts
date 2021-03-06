import {
  ConnectionInformations,
  CreateUser,
  DatabaseInterface,
  Session,
  User,
  CreateAuthenticator,
  Authenticator,
  CreateMfaChallenge,
  MfaChallenge,
} from '@accounts/types';
import { get, merge } from 'lodash';
import { Collection, Db, ObjectID, IndexOptions } from 'mongodb';

import { AccountsMongoOptions, MongoUser, MongoAuthenticator, MongoMfaChallenge } from './types';

const toMongoID = (objectId: string | ObjectID) => {
  if (typeof objectId === 'string') {
    return new ObjectID(objectId);
  }
  return objectId;
};

const defaultOptions = {
  collectionName: 'users',
  sessionCollectionName: 'sessions',
  authenticatorCollectionName: 'authenticators',
  mfaChallengeCollectionName: 'mfaChallenges',
  timestamps: {
    createdAt: 'createdAt',
    updatedAt: 'updatedAt',
  },
  convertUserIdToMongoObjectId: true,
  convertSessionIdToMongoObjectId: true,
  convertAuthenticatorIdToMongoObjectId: true,
  convertMfaChallengeIdToMongoObjectId: true,
  caseSensitiveUserName: true,
  dateProvider: (date?: Date) => (date ? date.getTime() : Date.now()),
};

export class Mongo implements DatabaseInterface {
  // Options of Mongo class
  private options: AccountsMongoOptions & typeof defaultOptions;
  // Db object
  private db: Db;
  // Account collection
  private collection: Collection;
  // Session collection
  private sessionCollection: Collection;
  // Authenticator collection
  private authenticatorCollection: Collection;
  // Mfa challenge collection
  private mfaChallengeCollection: Collection;

  constructor(db: any, options?: AccountsMongoOptions) {
    this.options = merge({ ...defaultOptions }, options);
    if (!db) {
      throw new Error('A database connection is required');
    }
    this.db = db;
    this.collection = this.db.collection(this.options.collectionName);
    this.sessionCollection = this.db.collection(this.options.sessionCollectionName);
    this.authenticatorCollection = this.db.collection(this.options.authenticatorCollectionName);
    this.mfaChallengeCollection = this.db.collection(this.options.mfaChallengeCollectionName);
  }

  /**
   * Setup the mongo indexes needed.
   * @param options Options passed to the mongo native `createIndex` method.
   */
  public async setupIndexes(options: Omit<IndexOptions, 'unique' | 'sparse'> = {}): Promise<void> {
    await this.sessionCollection.createIndex('token', {
      ...options,
      unique: true,
      sparse: true,
    });
    await this.collection.createIndex('username', {
      ...options,
      unique: true,
      sparse: true,
    });
    await this.collection.createIndex('emails.address', {
      ...options,
      unique: true,
      sparse: true,
    });
    // Index related to the password service
    await this.collection.createIndex('services.email.verificationTokens.token', {
      ...options,
      sparse: true,
    });
    await this.collection.createIndex('services.password.reset.token', {
      ...options,
      sparse: true,
    });
    // Index related to the mfa service
    await this.authenticatorCollection.createIndex('userId', {
      ...options,
      sparse: true,
    });
    await this.mfaChallengeCollection.createIndex('token', {
      ...options,
      unique: true,
      sparse: true,
    });
  }

  public async createUser({
    password,
    username,
    email,
    ...cleanUser
  }: CreateUser): Promise<string> {
    const user: MongoUser = {
      ...cleanUser,
      services: {},
      [this.options.timestamps.createdAt]: this.options.dateProvider(),
      [this.options.timestamps.updatedAt]: this.options.dateProvider(),
    };
    if (password) {
      user.services.password = { bcrypt: password };
    }
    if (username) {
      user.username = username;
    }
    if (email) {
      user.emails = [{ address: email.toLowerCase(), verified: false }];
    }
    if (this.options.idProvider) {
      user._id = this.options.idProvider();
    }
    const ret = await this.collection.insertOne(user);
    return (ret.ops[0]._id as ObjectID).toString();
  }

  public async findUserById(userId: string): Promise<User | null> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const user = await this.collection.findOne({ _id: id });
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async findUserByEmail(email: string): Promise<User | null> {
    const user = await this.collection.findOne({
      'emails.address': email.toLowerCase(),
    });
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async findUserByUsername(username: string): Promise<User | null> {
    const filter = this.options.caseSensitiveUserName
      ? { username }
      : {
          $where: `obj.username && (obj.username.toLowerCase() === "${username.toLowerCase()}")`,
        };
    const user = await this.collection.findOne(filter);
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async findPasswordHash(userId: string): Promise<string | null> {
    const user = await this.findUserById(userId);
    if (user) {
      return get(user, 'services.password.bcrypt');
    }
    return null;
  }

  public async findUserByEmailVerificationToken(token: string): Promise<User | null> {
    const user = await this.collection.findOne({
      'services.email.verificationTokens.token': token,
    });
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async findUserByResetPasswordToken(token: string): Promise<User | null> {
    const user = await this.collection.findOne({
      'services.password.reset.token': token,
    });
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async findUserByServiceId(serviceName: string, serviceId: string): Promise<User | null> {
    const user = await this.collection.findOne({
      [`services.${serviceName}.id`]: serviceId,
    });
    if (user) {
      user.id = user._id.toString();
    }
    return user;
  }

  public async addEmail(userId: string, newEmail: string, verified: boolean): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const ret = await this.collection.updateOne(
      { _id: id },
      {
        $addToSet: {
          emails: {
            address: newEmail.toLowerCase(),
            verified,
          },
        },
        $set: {
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
    if (ret.result.nModified === 0) {
      throw new Error('User not found');
    }
  }

  public async removeEmail(userId: string, email: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const ret = await this.collection.updateOne(
      { _id: id },
      {
        $pull: { emails: { address: email.toLowerCase() } },
        $set: {
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
    if (ret.result.nModified === 0) {
      throw new Error('User not found');
    }
  }

  public async verifyEmail(userId: string, email: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const ret = await this.collection.updateOne(
      { _id: id, 'emails.address': email },
      {
        $set: {
          'emails.$.verified': true,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
        $pull: { 'services.email.verificationTokens': { address: email } },
      }
    );
    if (ret.result.nModified === 0) {
      throw new Error('User not found');
    }
  }

  public async setUsername(userId: string, newUsername: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const ret = await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          username: newUsername,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
    if (ret.result.nModified === 0) {
      throw new Error('User not found');
    }
  }

  public async setPassword(userId: string, newPassword: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    const ret = await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          'services.password.bcrypt': newPassword,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
        $unset: {
          'services.password.reset': '',
        },
      }
    );
    if (ret.result.nModified === 0) {
      throw new Error('User not found');
    }
  }

  public async setService(userId: string, serviceName: string, service: object): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          [`services.${serviceName}`]: service,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async unsetService(userId: string, serviceName: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
        $unset: {
          [`services.${serviceName}`]: '',
        },
      }
    );
  }

  public async setUserDeactivated(userId: string, deactivated: boolean): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id: id },
      {
        $set: {
          deactivated,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async createSession(
    userId: string,
    token: string,
    connection: ConnectionInformations = {},
    extraData?: object
  ): Promise<string> {
    const session = {
      userId,
      token,
      userAgent: connection.userAgent,
      ip: connection.ip,
      extraData,
      valid: true,
      [this.options.timestamps.createdAt]: this.options.dateProvider(),
      [this.options.timestamps.updatedAt]: this.options.dateProvider(),
    };

    if (this.options.idProvider) {
      session._id = this.options.idProvider();
    }

    const ret = await this.sessionCollection.insertOne(session);
    return (ret.ops[0]._id as ObjectID).toString();
  }

  public async updateSession(
    sessionId: string,
    connection: ConnectionInformations,
    newToken?: string
  ): Promise<void> {
    const updateClause = {
      $set: {
        userAgent: connection.userAgent,
        ip: connection.ip,
        [this.options.timestamps.updatedAt]: this.options.dateProvider(),
      },
    };

    if (newToken) {
      updateClause.$set.token = newToken;
    }

    const _id = this.options.convertSessionIdToMongoObjectId ? toMongoID(sessionId) : sessionId;
    await this.sessionCollection.updateOne({ _id }, updateClause);
  }

  public async invalidateSession(sessionId: string): Promise<void> {
    const _id = this.options.convertSessionIdToMongoObjectId ? toMongoID(sessionId) : sessionId;
    await this.sessionCollection.updateOne(
      { _id },
      {
        $set: {
          valid: false,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async invalidateAllSessions(userId: string, excludedSessionIds?: string[]): Promise<void> {
    const selector: { userId: string; _id?: object } = { userId };

    if (excludedSessionIds && excludedSessionIds.length > 0) {
      let excludedObjectIds: string[] | ObjectID[] = excludedSessionIds;

      if (this.options.convertSessionIdToMongoObjectId) {
        excludedObjectIds = excludedSessionIds.map((sessionId) => {
          return toMongoID(sessionId);
        });
      }

      selector._id = {
        $nin: excludedObjectIds,
      };
    }

    await this.sessionCollection.updateMany(selector, {
      $set: {
        valid: false,
        [this.options.timestamps.updatedAt]: this.options.dateProvider(),
      },
    });
  }

  public async removeAllResetPasswordTokens(userId: string): Promise<void> {
    const id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id: id },
      {
        $unset: {
          'services.password.reset': '',
        },
      }
    );
  }

  public async findSessionByToken(token: string): Promise<Session | null> {
    const session = await this.sessionCollection.findOne({ token });
    if (session) {
      session.id = session._id.toString();
    }
    return session;
  }

  public async findSessionById(sessionId: string): Promise<Session | null> {
    const _id = this.options.convertSessionIdToMongoObjectId ? toMongoID(sessionId) : sessionId;
    const session = await this.sessionCollection.findOne({ _id });
    if (session) {
      session.id = session._id.toString();
    }
    return session;
  }

  public async addEmailVerificationToken(
    userId: string,
    email: string,
    token: string
  ): Promise<void> {
    const _id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id },
      {
        $push: {
          'services.email.verificationTokens': {
            token,
            address: email.toLowerCase(),
            when: this.options.dateProvider(),
          },
        },
      }
    );
  }

  public async addResetPasswordToken(
    userId: string,
    email: string,
    token: string,
    reason: string
  ): Promise<void> {
    const _id = this.options.convertUserIdToMongoObjectId ? toMongoID(userId) : userId;
    await this.collection.updateOne(
      { _id },
      {
        $push: {
          'services.password.reset': {
            token,
            address: email.toLowerCase(),
            when: this.options.dateProvider(),
            reason,
          },
        },
      }
    );
  }

  public async setResetPassword(userId: string, email: string, newPassword: string): Promise<void> {
    await this.setPassword(userId, newPassword);
  }

  /**
   * MFA authenticators related operations
   */

  public async createAuthenticator(newAuthenticator: CreateAuthenticator): Promise<string> {
    const authenticator: MongoAuthenticator = {
      ...newAuthenticator,
      [this.options.timestamps.createdAt]: this.options.dateProvider(),
      [this.options.timestamps.updatedAt]: this.options.dateProvider(),
    };
    if (this.options.idProvider) {
      authenticator._id = this.options.idProvider();
    }
    const ret = await this.authenticatorCollection.insertOne(authenticator);
    return (ret.ops[0]._id as ObjectID).toString();
  }

  public async findAuthenticatorById(authenticatorId: string): Promise<Authenticator | null> {
    const id = this.options.convertAuthenticatorIdToMongoObjectId
      ? toMongoID(authenticatorId)
      : authenticatorId;
    const authenticator = await this.authenticatorCollection.findOne({ _id: id });
    if (authenticator) {
      authenticator.id = authenticator._id.toString();
    }
    return authenticator;
  }

  public async findUserAuthenticators(userId: string): Promise<Authenticator[]> {
    const authenticators = await this.authenticatorCollection.find({ userId }).toArray();
    authenticators.forEach((authenticator) => {
      authenticator.id = authenticator._id.toString();
    });
    return authenticators;
  }

  public async activateAuthenticator(authenticatorId: string): Promise<void> {
    const id = this.options.convertAuthenticatorIdToMongoObjectId
      ? toMongoID(authenticatorId)
      : authenticatorId;
    await this.authenticatorCollection.updateOne(
      { _id: id },
      {
        $set: {
          active: true,
          activatedAt: this.options.dateProvider(),
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async deactivateAuthenticator(authenticatorId: string): Promise<void> {
    const id = this.options.convertAuthenticatorIdToMongoObjectId
      ? toMongoID(authenticatorId)
      : authenticatorId;
    await this.authenticatorCollection.updateOne(
      { _id: id },
      {
        $set: {
          active: false,
          deactivatedAt: this.options.dateProvider(),
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async updateAuthenticator(
    authenticatorId: string,
    data: Partial<Authenticator>
  ): Promise<void> {
    const id = this.options.convertAuthenticatorIdToMongoObjectId
      ? toMongoID(authenticatorId)
      : authenticatorId;
    await this.authenticatorCollection.updateOne(
      { _id: id },
      {
        $set: {
          ...data,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  /**
   * MFA challenges related operations
   */

  public async createMfaChallenge(newMfaChallenge: CreateMfaChallenge): Promise<string> {
    const mfaChallenge: MongoMfaChallenge = {
      ...newMfaChallenge,
      [this.options.timestamps.createdAt]: this.options.dateProvider(),
      [this.options.timestamps.updatedAt]: this.options.dateProvider(),
    };
    if (this.options.idProvider) {
      mfaChallenge._id = this.options.idProvider();
    }
    const ret = await this.mfaChallengeCollection.insertOne(mfaChallenge);
    return (ret.ops[0]._id as ObjectID).toString();
  }

  public async findMfaChallengeByToken(token: string): Promise<MfaChallenge | null> {
    const mfaChallenge = await this.mfaChallengeCollection.findOne({
      token,
    });
    if (mfaChallenge) {
      mfaChallenge.id = mfaChallenge._id.toString();
    }
    return mfaChallenge;
  }

  public async deactivateMfaChallenge(mfaChallengeId: string): Promise<void> {
    const id = this.options.convertMfaChallengeIdToMongoObjectId
      ? toMongoID(mfaChallengeId)
      : mfaChallengeId;
    await this.mfaChallengeCollection.updateOne(
      { _id: id },
      {
        $set: {
          deactivated: true,
          deactivatedAt: this.options.dateProvider(),
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }

  public async updateMfaChallenge(
    mfaChallengeId: string,
    data: Partial<MfaChallenge>
  ): Promise<void> {
    const id = this.options.convertMfaChallengeIdToMongoObjectId
      ? toMongoID(mfaChallengeId)
      : mfaChallengeId;
    await this.mfaChallengeCollection.updateOne(
      { _id: id },
      {
        $set: {
          ...data,
          [this.options.timestamps.updatedAt]: this.options.dateProvider(),
        },
      }
    );
  }
}
