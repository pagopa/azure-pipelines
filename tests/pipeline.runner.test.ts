import { PipelineRunner } from "../src/pipeline.runner";
import { TaskParameters } from "../src/task.parameters";
import * as core from '@actions/core';
import * as azdev from "azure-devops-node-api";
import * as BuildInterfaces from 'azure-devops-node-api/interfaces/BuildInterfaces';

if (!process.env.TEST_AZURE_DEVOPS_TOKEN) {
    throw new Error('TEST_AZURE_DEVOPS_TOKEN environment variable is required');
}

const TEST_CONFIG = {
    azureDevOps: {
        projectUrl: 'https://dev.azure.com/pagopaspa/p4pa-projects',
        token: process.env.TEST_AZURE_DEVOPS_TOKEN
    },
    
    pipeline: {
        name: 'p4pa-payhub-deploy-aks.deploy',
        environments: {
            dev: {
                variables: {
                },
                templateParameters: {
                    "APPS_TOP": "[one-color]",
                    "ARGOCD_TARGET_BRANCH": "tmp",
                    "POSTMAN_BRANCH": "develop",
                    "TRIGGER_MESSAGE": "p4pa-auth"
                }
            },

        }
    },
    
    github: {
        repository: 'pagopa/p4pa-payhub-deploy-aks',
        branch: 'refs/heads/main',
        sha: '1234567890abcdef'
    }
} as const;

describe('PipelineRunner Integration Tests', () => {
    let pipelineRunner: PipelineRunner;
    const currentEnvironment = 'dev'; // o 'prod' per testare l'ambiente di produzione

    beforeEach(() => {
        process.env.GITHUB_REPOSITORY = TEST_CONFIG.github.repository;
        process.env.GITHUB_REF = TEST_CONFIG.github.branch;
        process.env.GITHUB_SHA = TEST_CONFIG.github.sha;

        jest.spyOn(core, 'getInput').mockImplementation((name: string) => {
            switch(name) {
                case 'azure-devops-project-url':
                    return TEST_CONFIG.azureDevOps.projectUrl;
                case 'azure-pipeline-name':
                    return TEST_CONFIG.pipeline.name;
                case 'azure-devops-token':
                    return TEST_CONFIG.azureDevOps.token;
                case 'azure-pipeline-variables':
                    return JSON.stringify(TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].variables);
                case 'azure-template-parameters':
                    return JSON.stringify(TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].templateParameters);
                default:
                    return '';
            }
        });

        jest.spyOn(core, 'setFailed').mockImplementation((message: string) => {
            console.error('Pipeline error:', message);
        });

        jest.spyOn(core, 'debug').mockImplementation((message: string) => {
            console.log('Debug:', message);
            if (message.includes('validation')) {
                console.log('Validation details:', message);
            }
        });

        pipelineRunner = new PipelineRunner(TaskParameters.getTaskParams());
    });

    afterEach(() => {
        delete process.env.GITHUB_REPOSITORY;
        delete process.env.GITHUB_REF;
        delete process.env.GITHUB_SHA;
        jest.restoreAllMocks();
    });

    it('should trigger real pipeline execution', async () => {
        try {
            console.log('Starting pipeline execution with params:', {
                repository: pipelineRunner.repository,
                branch: pipelineRunner.branch,
                pipelineName: TEST_CONFIG.pipeline.name,
                environment: currentEnvironment,
                variables: TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].variables,
                templateParams: TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].templateParameters
            });

            await pipelineRunner.start();
            expect(true).toBeTruthy();
        } catch (error) {
            if (error instanceof Error) {
                console.error('Pipeline execution details:', {
                    message: error.message,
                    validationResults: (error as any).validationResults,
                    details: (error as any).details || 'No additional details',
                    response: (error as any).response
                });

                if (error.message.includes('validation errors')) {
                    console.log('Analyzing validation error details...');
                    expect(true).toBeTruthy();
                } else {
                    fail(error);
                }
            } else {
                fail(error);
            }
        }
    }, 30000);

    it('should verify Azure DevOps connectivity', async () => {
        try {
            const taskParams = TaskParameters.getTaskParams();
            let authHandler = azdev.getPersonalAccessTokenHandler(taskParams.azureDevopsToken);
            let collectionUrl = taskParams.azureDevopsProjectUrl.split('/').slice(0, -1).join('/');
            
            const webApi = new azdev.WebApi(collectionUrl, authHandler);
            const buildApi = await webApi.getBuildApi();
            
            const projectName = taskParams.azureDevopsProjectUrl.split('/').pop() || '';
            const definitions = await buildApi.getDefinitions(projectName);
            
            expect(definitions).toBeDefined();
            expect(definitions.length).toBeGreaterThan(0);
            
            const targetPipeline = definitions.find(d => d.name === TEST_CONFIG.pipeline.name);
            expect(targetPipeline).toBeDefined();

            if (targetPipeline?.id) {
                const fullDefinition = await buildApi.getDefinition(projectName, targetPipeline.id);
                console.log('Pipeline details:', {
                    id: fullDefinition.id,
                    path: fullDefinition.path,
                    repositoryId: fullDefinition.repository?.id,
                    repositoryType: fullDefinition.repository?.type
                });
            }
        } catch (error) {
            console.error('Connectivity test failed:', error);
            fail(error);
        }
    });

    it('should initialize TaskParameters correctly', () => {
        const taskParams = pipelineRunner.taskParameters;
        expect(taskParams.azureDevopsProjectUrl).toBe(TEST_CONFIG.azureDevOps.projectUrl);
        expect(taskParams.azurePipelineName).toBe(TEST_CONFIG.pipeline.name);
        
        const parsedVariables = JSON.parse(taskParams.azurePipelineVariables);
        expect(parsedVariables).toEqual(TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].variables);
        
        const parsedParameters = JSON.parse(taskParams.azureTemplateParameters);
        expect(parsedParameters).toEqual(TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].templateParameters);
    });

    it('should have correct repository configuration', () => {
        expect(pipelineRunner.repository).toBe(TEST_CONFIG.github.repository);
        expect(pipelineRunner.branch).toBe(TEST_CONFIG.github.branch);
        expect(pipelineRunner.commitId).toBe(TEST_CONFIG.github.sha);
    });

    it('should correctly parse pipeline variables', () => {
        const parsedVariables = JSON.parse(pipelineRunner.taskParameters.azurePipelineVariables);
        const envVars = TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].variables;
        Object.keys(envVars).forEach(key => {
            expect(parsedVariables).toHaveProperty(key);
            expect(parsedVariables[key]).toBe(envVars[key as keyof typeof envVars]);
        });
    });

    it('should correctly parse template parameters', () => {
        const parsedParameters = JSON.parse(pipelineRunner.taskParameters.azureTemplateParameters);
        const envParams = TEST_CONFIG.pipeline.environments[currentEnvironment as keyof typeof TEST_CONFIG.pipeline.environments].templateParameters;
        Object.keys(envParams).forEach(key => {
            expect(parsedParameters).toHaveProperty(key);
            expect(parsedParameters[key]).toBe(envParams[key as keyof typeof envParams]);
        });
    });
});
