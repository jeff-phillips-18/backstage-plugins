import { Config } from '@backstage/config';
import { ConfigApi } from '@backstage/core-plugin-api';
import {
  BackstageIdentityResponse,
  BackstageUserIdentity,
} from '@backstage/plugin-auth-node';
import {
  AuthorizeResult,
  isResourcePermission,
  PolicyDecision,
} from '@backstage/plugin-permission-common';
import {
  PermissionPolicy,
  PolicyQuery,
} from '@backstage/plugin-permission-node';

import { Enforcer, FileAdapter, newEnforcer, newModelFromString } from 'casbin';
import { Logger } from 'winston';

import { MODEL } from './permission-model';

const useAdmins = async (admins: Config[], enf: Enforcer) => {
  const adminRoleName = 'role:default/rbac_admin';
  admins.flatMap(async localConfig => {
    const name = localConfig.getString('name');
    const adminRole = [name, adminRoleName];
    if (!(await enf.hasGroupingPolicy(...adminRole))) {
      await enf.addGroupingPolicy(...adminRole);
    }
  });
  const adminReadPermission = [adminRoleName, 'policy-entity', 'read', 'allow'];
  if (!(await enf.hasPolicy(...adminReadPermission))) {
    await enf.addPolicy(...adminReadPermission);
  }
  const adminCreatePermission = [
    adminRoleName,
    'policy-entity',
    'create',
    'allow',
  ];
  if (!(await enf.hasPolicy(...adminCreatePermission))) {
    await enf.addPolicy(...adminCreatePermission);
  }

  const adminDeletePermission = [
    adminRoleName,
    'policy-entity',
    'delete',
    'allow',
  ];
  if (!(await enf.hasPolicy(...adminDeletePermission))) {
    await enf.addPolicy(...adminDeletePermission);
  }

  const adminUpdatePermission = [
    adminRoleName,
    'policy-entity',
    'update',
    'allow',
  ];
  if (!(await enf.hasPolicy(...adminUpdatePermission))) {
    await enf.addPolicy(...adminUpdatePermission);
  }
};

const addPredefinedPolicies = async (
  preDefinedPoliciesFile: string,
  enf: Enforcer,
) => {
  const fileEnf = await newEnforcer(
    newModelFromString(MODEL),
    new FileAdapter(preDefinedPoliciesFile),
  );
  const policies = await fileEnf.getPolicy();
  for (const policy of policies) {
    if (!(await enf.hasPolicy(...policy))) {
      await enf.addPolicy(...policy);
    }
  }
};

export class RBACPermissionPolicy implements PermissionPolicy {
  private readonly enforcer: Enforcer;
  private readonly logger: Logger;

  public static async build(
    logger: Logger,
    configApi: ConfigApi,
    enf: Enforcer,
  ): Promise<RBACPermissionPolicy> {
    const adminUsers = configApi.getOptionalConfigArray(
      'permission.rbac.admin.users',
    );

    const policiesFile = configApi.getOptionalString(
      'permission.rbac.policies-csv-file',
    );

    if (policiesFile) {
      await addPredefinedPolicies(policiesFile, enf);
    }

    if (adminUsers) {
      useAdmins(adminUsers, enf);
    }

    return new RBACPermissionPolicy(enf, logger);
  }

  private constructor(enforcer: Enforcer, logger: Logger) {
    this.enforcer = enforcer;
    this.logger = logger;
  }

  async handle(
    request: PolicyQuery,
    identityResp?: BackstageIdentityResponse | undefined,
  ): Promise<PolicyDecision> {
    this.logger.info(
      `Policy check for ${identityResp?.identity.userEntityRef} for permission ${request.permission.name}`,
    );
    try {
      let status = false;

      // We are introducing an action named "use" when action does not exist to avoid
      // a more complicated model with multiple policy and request shapes.
      const action = request.permission.attributes.action ?? 'use';

      if (isResourcePermission(request.permission)) {
        status = await this.isAuthorized(
          identityResp?.identity,
          request.permission.resourceType,
          action,
        );
      } else {
        status = await this.isAuthorized(
          identityResp?.identity,
          request.permission.name,
          action,
        );
      }

      const result = status ? AuthorizeResult.ALLOW : AuthorizeResult.DENY;
      this.logger.info(
        `${identityResp?.identity.userEntityRef} is ${result} for permission ${request.permission.name} and action ${action}`,
      );
      return Promise.resolve({
        result: result,
      });
    } catch (error) {
      this.logger.error(`Policy check failed with ${error}`);
      return Promise.resolve({
        result: AuthorizeResult.DENY,
      });
    }
  }

  private isAuthorized = async (
    identity: BackstageUserIdentity | undefined,
    resourceType: string,
    action: string,
  ): Promise<boolean> => {
    if (!identity) {
      return false;
    }

    const entityRef = identity.userEntityRef;

    return await this.enforcer.enforce(entityRef, resourceType, action);
  };
}
