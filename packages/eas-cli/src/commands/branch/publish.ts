import { getConfig, getDefaultTarget } from '@expo/config';
import { getRuntimeVersionForSDKVersion } from '@expo/sdk-runtime-versions';
import { Command, flags } from '@oclif/command';
import assert from 'assert';
import chalk from 'chalk';
import dateFormat from 'dateformat';
import gql from 'graphql-tag';
import { uniqBy } from 'lodash';
import ora from 'ora';

import { graphqlClient, withErrorHandlingAsync } from '../../graphql/client';
import {
  Actor,
  GetUpdateGroupAsyncQuery,
  RootQueryUpdatesByGroupArgs,
  Update,
  UpdateInfoGroup,
} from '../../graphql/generated';
import { PublishMutation } from '../../graphql/mutations/PublishMutation';
import Log from '../../log';
import { findProjectRootAsync, getProjectIdAsync } from '../../project/projectUtils';
import {
  PublishPlatform,
  buildBundlesAsync,
  buildUpdateInfoGroupAsync,
  collectAssets,
  uploadAssetsAsync,
} from '../../project/publish';
import { promptAsync, selectAsync } from '../../prompts';
import { formatUpdate } from '../../update/utils';
import formatFields from '../../utils/formatFields';
import vcs from '../../vcs';
import { listBranchesAsync } from './list';
import { viewUpdateBranchAsync } from './view';

export const defaultPublishPlatforms: PublishPlatform[] = ['android', 'ios'];
type PlatformFlag = PublishPlatform | 'all';

async function getUpdateGroupAsync({
  group,
}: RootQueryUpdatesByGroupArgs): Promise<GetUpdateGroupAsyncQuery['updatesByGroup']> {
  const { updatesByGroup } = await withErrorHandlingAsync(
    graphqlClient
      .query<GetUpdateGroupAsyncQuery, RootQueryUpdatesByGroupArgs>(
        gql`
          query getUpdateGroupAsync($group: ID!) {
            updatesByGroup(group: $group) {
              id
              group
              runtimeVersion
              manifestFragment
              platform
              message
            }
          }
        `,
        {
          group,
        }
      )
      .toPromise()
  );
  return updatesByGroup;
}

export default class BranchPublish extends Command {
  static hidden = true;
  static description = 'Publish an update group to a branch.';

  static args = [
    {
      name: 'name',
      description: 'Name of the branch to publish on',
    },
  ];

  static flags = {
    message: flags.string({
      description: 'Short message describing the updates.',
      required: false,
    }),
    republish: flags.boolean({
      description: 'republish an update group',
      exclusive: ['input-dir', 'skip-bundler'],
    }),
    group: flags.string({
      description: 'update group to republish',
      exclusive: ['input-dir', 'skip-bundler'],
    }),
    'input-dir': flags.string({
      description: 'location of the bundle',
      default: 'dist',
      required: false,
    }),
    'skip-bundler': flags.boolean({
      description: `skip running Expo CLI to bundle the app before publishing`,
      default: false,
    }),
    platform: flags.enum({
      char: 'p',
      description: `Only publish to a single platform`,
      options: [...defaultPublishPlatforms, 'all'],
      default: 'all',
      required: false,
    }),
    json: flags.boolean({
      description: `return a json with the new update group.`,
      default: false,
    }),
  };

  async run() {
    let {
      args: { name },
      flags: {
        json: jsonFlag,
        message,
        republish,
        group,
        'input-dir': inputDir,
        'skip-bundler': skipBundler,
      },
    } = this.parse(BranchPublish);
    const platformFlag = this.parse(BranchPublish).flags.platform as PlatformFlag;
    // If a group was specified, that means we are republishing it.
    republish = group ? true : republish;

    const projectDir = await findProjectRootAsync(process.cwd());
    if (!projectDir) {
      throw new Error('Please run this command inside a project directory.');
    }

    const { exp } = getConfig(projectDir, {
      skipSDKVersionRequirement: true,
      isPublicConfig: true,
    });
    let { runtimeVersion, sdkVersion } = exp;

    // When a SDK version is supplied instead of a runtime version and we're in the managed workflow
    // construct the runtimeVersion with special meaning indicating that the runtime is an
    // Expo SDK preset runtime that can be launched in Expo Go.
    const isManagedProject = getDefaultTarget(projectDir) === 'managed';
    if (!runtimeVersion && sdkVersion && isManagedProject) {
      Log.withTick('Generating runtime version from sdk version');
      runtimeVersion = getRuntimeVersionForSDKVersion(sdkVersion);
    }

    if (!runtimeVersion) {
      throw new Error(
        "Couldn't find 'runtimeVersion'. Please specify it under the 'expo' key in 'app.json'"
      );
    }
    const projectId = await getProjectIdAsync(exp);

    if (!name) {
      const validationMessage = 'branch name may not be empty.';
      if (jsonFlag) {
        throw new Error(validationMessage);
      }

      const branches = await listBranchesAsync({ projectId });
      name = await selectAsync<string>(
        'which branch would you like to publish on?',
        branches.map(branch => {
          return {
            title: `${branch.name} ${chalk.grey(
              `- current update: ${formatUpdate(branch.updates[0])}`
            )}`,
            value: branch.name,
          };
        })
      );
    }
    assert(name, 'branch name must be specified.');

    const { id: branchId, updates } = await viewUpdateBranchAsync({
      appId: projectId,
      name,
    });

    let updateInfoGroup: UpdateInfoGroup = {};
    let oldMessage: string, oldRuntimeVersion: string;
    if (republish) {
      // If we are republishing, we don't need to worry about building the bundle or uploading the assets.
      // Instead we get the `updateInfoGroup` from the update we wish to republish.
      let updatesToRepublish: Pick<
        Update,
        'group' | 'message' | 'runtimeVersion' | 'manifestFragment' | 'platform'
      >[];
      if (group) {
        updatesToRepublish = await getUpdateGroupAsync({ group });
      } else {
        // Drop into interactive mode if the user has not specified an update group to republish.
        if (jsonFlag) {
          throw new Error('You must specify the update group to republish.');
        }

        const updateGroups = uniqBy(updates, u => u.group)
          .filter(update => {
            // Only show groups that have updates on the specified platform(s).
            return platformFlag === 'all' || update.platform === platformFlag;
          })
          .map(update => ({
            title: formatUpdateTitle(update),
            value: update.group,
          }));
        if (updateGroups.length === 0) {
          throw new Error(
            `There are no updates on branch "${name}" published on the platform(s) ${platformFlag}. Did you mean to publish a new update instead?`
          );
        }

        const selectedUpdateGroup = await selectAsync<string>(
          'which update would you like to republish?',
          updateGroups
        );
        updatesToRepublish = updates.filter(update => update.group === selectedUpdateGroup);
      }
      const updatesToRepublishFilteredByPlatform = updatesToRepublish.filter(
        // Only republish to the specified platforms
        update => platformFlag === 'all' || update.platform === platformFlag
      );
      if (updatesToRepublishFilteredByPlatform.length === 0) {
        throw new Error(
          `There are no updates on branch "${name}" published on the platform(s) "${platformFlag}" with group ID "${
            group ? group : updatesToRepublish[0].group
          }". Did you mean to publish a new update instead?`
        );
      }

      let publicationPlatformMessage: string;
      if (platformFlag === 'all') {
        if (updatesToRepublishFilteredByPlatform.length !== defaultPublishPlatforms.length) {
          Log.warn(`You are republishing an update that wasn't published for all platforms.`);
        }
        publicationPlatformMessage = `The republished update will appear on the same plaforms it was originally published on: ${updatesToRepublishFilteredByPlatform
          .map(update => update.platform)
          .join(',')}`;
      } else {
        publicationPlatformMessage = `The republished update will appear only on: ${platformFlag}`;
      }
      Log.withTick(publicationPlatformMessage);

      for (const update of updatesToRepublishFilteredByPlatform) {
        const { manifestFragment } = update;
        const platform = update.platform as PublishPlatform;

        updateInfoGroup[platform] = JSON.parse(manifestFragment);
      }

      // These are the same for each member of an update group
      group = updatesToRepublishFilteredByPlatform[0].group;
      oldMessage = updatesToRepublishFilteredByPlatform[0].message ?? '';
      oldRuntimeVersion = updatesToRepublishFilteredByPlatform[0].runtimeVersion;
    } else {
      // build bundle and upload assets for a new publish
      if (!skipBundler) {
        await buildBundlesAsync({ projectDir, inputDir });
      }

      const assetSpinner = ora('Uploading assets...').start();
      try {
        const platforms = platformFlag === 'all' ? defaultPublishPlatforms : [platformFlag];
        const assets = collectAssets({ inputDir: inputDir!, platforms });
        await uploadAssetsAsync(assets);
        updateInfoGroup = await buildUpdateInfoGroupAsync(assets, exp);
        assetSpinner.succeed('Uploaded assets!');
      } catch (e) {
        assetSpinner.fail('Failed to upload assets');
        throw e;
      }
    }

    if (!message) {
      const validationMessage = 'publish message may not be empty.';
      if (jsonFlag) {
        throw new Error(validationMessage);
      }
      ({ publishMessage: message } = await promptAsync({
        type: 'text',
        name: 'publishMessage',
        message: `Please enter a publication message.`,
        initial: republish
          ? `Republish "${oldMessage!}" - group: ${group}`
          : (await vcs.getLastCommitMessageAsync())?.trim(),
        validate: value => (value ? true : validationMessage),
      }));
    }

    let newUpdateGroup;
    const publishSpinner = ora('Publishing...').start();
    try {
      newUpdateGroup = await PublishMutation.publishUpdateGroupAsync({
        branchId,
        updateInfoGroup,
        runtimeVersion: republish ? oldRuntimeVersion! : runtimeVersion,
        message,
      });
      publishSpinner.succeed('Published!');
    } catch (e) {
      publishSpinner.fail('Failed to published updates');
      throw e;
    }

    if (jsonFlag) {
      Log.log(JSON.stringify(newUpdateGroup));
    } else {
      Log.log(
        formatFields([
          { label: 'branch', value: name },
          { label: 'runtime version', value: runtimeVersion },
          { label: 'update group ID', value: newUpdateGroup.group },
          { label: 'message', value: message },
        ])
      );
    }
  }
}

function formatUpdateTitle(
  update: Pick<Update, 'message' | 'createdAt' | 'runtimeVersion'> & {
    actor?: Pick<Actor, 'firstName'> | null;
  }
): string {
  const { message, createdAt, actor, runtimeVersion } = update;
  return `[${dateFormat(createdAt, 'mmm dd HH:MM')} by ${
    actor?.firstName ?? 'unknown'
  }, runtimeVersion: ${runtimeVersion}] ${message}`;
}
