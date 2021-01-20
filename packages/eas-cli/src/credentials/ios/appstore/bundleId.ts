import { BundleId, Profile, RequestContext } from '@expo/apple-utils';

import { promptAsync } from '../../../prompts';

async function getProfilesForBundleIdDangerousAsync(
  context: RequestContext,
  bundleIdentifier: string
): Promise<Profile[]> {
  const bundleId = await BundleId.findAsync(context, { identifier: bundleIdentifier });
  if (bundleId) {
    return bundleId.getProfilesAsync();
  }
  return [];
}

export async function getProfilesForBundleIdAsync(
  context: RequestContext,
  bundleIdentifier: string
): Promise<Profile[]> {
  const profiles = await getProfilesForBundleIdDangerousAsync(context, bundleIdentifier);
  await promptAsync({
    type: 'select',
    name: 'selected',
    message: `Did you delete a profile yet? ${profiles.map(profile => profile.id)}`,
    choices: [
      {
        title: 'Yes',
        value: 'Yes',
      },
    ],
  });
  // users sometimes have a poisoned Apple cache and receive stale data from the API
  // we call an arbitrary method, `getBundleIdAsync` on each profile
  // if it errors, the profile was stale, so we remove it
  const validProfileIds = new Set();
  await Promise.all(
    profiles.map(async profile => {
      try {
        await profile.getBundleIdAsync();
        validProfileIds.add(profile.id);
      } catch (e) {
        if (
          e.name === 'UnexpectedAppleResponse' &&
          e.message.includes('The specified resource does not exist - There is no resource of type')
        ) {
          return;
        }
        throw e;
      }
    })
  );
  return profiles.filter(profile => validProfileIds.has(profile.id));
}

export async function getBundleIdForIdentifierAsync(
  context: RequestContext,
  bundleIdentifier: string
): Promise<BundleId> {
  const bundleId = await BundleId.findAsync(context, { identifier: bundleIdentifier });
  if (!bundleId) {
    throw new Error(`Failed to find Bundle ID item with identifier "${bundleIdentifier}"`);
  }
  return bundleId;
}
