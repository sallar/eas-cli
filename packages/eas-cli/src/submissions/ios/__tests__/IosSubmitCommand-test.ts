import { vol } from 'memfs';
import { v4 as uuidv4 } from 'uuid';

import { asMock } from '../../../__tests__/utils';
import { jester as mockJester } from '../../../credentials/__tests__/fixtures-constants';
import { AppPlatform, SubmissionFragment, SubmissionStatus } from '../../../graphql/generated';
import { createTestProject } from '../../../project/__tests__/project-utils';
import { getProjectIdAsync } from '../../../project/projectUtils';
import SubmissionService from '../../SubmissionService';
import { IosSubmitCommandFlags } from '../../types';
import { IosSubmissionConfig } from '../IosSubmissionConfig';
import IosSubmitCommand from '../IosSubmitCommand';

jest.mock('fs');
jest.mock('ora');
jest.mock('../../SubmissionService');
jest.mock('../../../project/ensureProjectExists');
jest.mock('../../../user/User', () => ({
  getUserAsync: jest.fn(() => mockJester),
}));
jest.mock('../../../user/actions', () => ({
  ensureLoggedInAsync: jest.fn(() => mockJester),
}));
jest.mock('../../../project/projectUtils');

describe(IosSubmitCommand, () => {
  const testProject = createTestProject(mockJester, {});

  const fakeFiles: Record<string, string> = {
    '/artifacts/fake.ipa': 'fake ipa',
  };

  beforeAll(() => {
    vol.fromJSON({
      ...testProject.projectTree,
      ...fakeFiles,
    });

    const mockManifest = { exp: testProject.appJSON.expo };
    jest.mock('@expo/config', () => ({
      getConfig: jest.fn(() => mockManifest),
    }));
  });
  afterAll(() => {
    vol.reset();

    jest.unmock('@expo/config');
  });

  afterEach(() => {
    asMock(getProjectIdAsync).mockClear();
  });

  describe('sending submission', () => {
    const originalStartSubmissionAsync = SubmissionService.startSubmissionAsync;
    const originalGetSubmissionAsync = SubmissionService.getSubmissionAsync;
    beforeAll(() => {
      SubmissionService.startSubmissionAsync = jest.fn(SubmissionService.startSubmissionAsync);
      SubmissionService.getSubmissionAsync = jest.fn(SubmissionService.getSubmissionAsync);
    });
    afterAll(() => {
      SubmissionService.startSubmissionAsync = originalStartSubmissionAsync;
      SubmissionService.getSubmissionAsync = originalGetSubmissionAsync;
    });
    afterEach(() => {
      asMock(SubmissionService.startSubmissionAsync).mockClear();
      asMock(SubmissionService.getSubmissionAsync).mockClear();
    });

    it('sends a request to Submission Service', async () => {
      const projectId = uuidv4();
      asMock(SubmissionService.getSubmissionAsync).mockImplementationOnce(
        async (submissionId: string): Promise<SubmissionFragment> => {
          const actualSubmission = await originalGetSubmissionAsync(submissionId);
          return {
            ...actualSubmission,
            status: SubmissionStatus.Finished,
          };
        }
      );
      asMock(getProjectIdAsync).mockImplementationOnce(() => projectId);

      process.env.EXPO_APPLE_APP_SPECIFIC_PASSWORD = 'supersecret';

      const options: IosSubmitCommandFlags = {
        latest: false,
        url: 'http://expo.io/fake.ipa',
        appleId: 'test@example.com',
        ascAppId: '12345678',
        verbose: false,
      };
      const ctx = IosSubmitCommand.createContext(testProject.projectRoot, projectId, options);
      const command = new IosSubmitCommand(ctx);
      await command.runAsync();

      const iosSubmissionConfig: IosSubmissionConfig = {
        archiveUrl: 'http://expo.io/fake.ipa',
        appleId: 'test@example.com',
        appSpecificPassword: 'supersecret',
        appAppleId: '12345678',
        projectId,
      };

      expect(SubmissionService.startSubmissionAsync).toHaveBeenCalledWith(
        AppPlatform.Ios,
        projectId,
        iosSubmissionConfig,
        undefined
      );

      delete process.env.EXPO_APPLE_APP_SPECIFIC_PASSWORD;
    });
  });
});
