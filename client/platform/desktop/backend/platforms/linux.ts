/**
 * VIAME process manager for linux platform
 */
import npath from 'path';
import { spawn } from 'child_process';
import fs from 'fs-extra';

import {
  Settings, SettingsCurrentVersion,
  DesktopJob, DesktopJobUpdate,
  RunPipeline, TrainPipeline,
} from '../../constants';
import common from './common';

const DefaultSettings: Settings = {
  // The current settings schema config
  version: SettingsCurrentVersion,
  // A path to the VIAME base install
  viamePath: '/opt/noaa/viame',
  // Path to a user data folder
  dataPath: '~/viamedata',
};
// Script to source before `kwiver` will be available
const SetupScriptName = 'setup_viame.sh';
// Path on viamePath where included pipelines are
const PreTrainedPipelinesPath = 'configs/pipelines';
// Path on viamePath to detector training executable
const TrainingExecutablePath = 'bin/viame_train_detector';
// Path to viamePath to training configurations
const TrainingConfigPath = npath.join(PreTrainedPipelinesPath, 'config');

/**
 * Check viamePath, check that kwiver will initialize.
 * @param settings user settings
 */
async function validateViamePath(settings: Settings): Promise<true | string> {
  const setupScriptPath = npath.join(settings.viamePath, SetupScriptName);
  const setupExists = await fs.pathExists(setupScriptPath);
  if (!setupExists) {
    return `${setupScriptPath} does not exist`;
  }

  const kwiverExistsOnPath = spawn(
    `source ${setupScriptPath} && which kwiver`,
    { shell: '/bin/bash' },
  );
  return new Promise((resolve) => {
    kwiverExistsOnPath.on('exit', (code) => {
      if (code === 0) {
        resolve(true);
      } else {
        resolve('kwiver failed to initialize');
      }
    });
  });
}

/**
 * Fashioned as a node.js implementation of viame_tasks.tasks.run_pipeline
 *
 * @param runPipelineArgs args
 * @param updater callback for logs
 * @returns job
 */
async function runPipeline(
  runPipelineArgs: RunPipeline,
  updater: (msg: DesktopJobUpdate) => void,
): Promise<DesktopJob> {
  const { settings, datasetId, pipelineName } = runPipelineArgs;
  const isValid = await validateViamePath(settings);
  if (isValid !== true) {
    throw new Error(isValid);
  }

  const setupScriptPath = npath.join(settings.viamePath, SetupScriptName);
  const pipelinePath = npath.join(settings.viamePath, PreTrainedPipelinesPath, pipelineName);
  const datasetInfo = await common.getDatasetBase(datasetId);
  const auxPath = await common.getAuxFolder(datasetInfo.basePath);
  const jobWorkDir = await common.createKwiverRunWorkingDir(
    datasetInfo.name, auxPath, pipelineName,
  );

  const detectorOutput = npath.join(jobWorkDir, 'detector_output.csv');
  const trackOutput = npath.join(jobWorkDir, 'track_output.csv');
  const joblog = npath.join(jobWorkDir, 'runlog.txt');

  let command: string[] = [];
  if (datasetInfo.datasetType === 'video') {
    command = [
      `source ${setupScriptPath} &&`,
      'kwiver runner',
      '-s input:video_reader:type=vidl_ffmpeg',
      `-p ${pipelinePath}`,
      `-s input:video_filename=${datasetId}`,
      `-s detector_writer:file_name=${detectorOutput}`,
      `-s track_writer:file_name=${trackOutput}`,
      `| tee ${joblog}`,
    ];
  } else if (datasetInfo.datasetType === 'image-sequence') {
    // Create frame image manifest
    const manifestFile = npath.join(jobWorkDir, 'image-manifest.txt');
    // map image file names to absolute paths
    const fileData = datasetInfo.imageFiles
      .map((f) => npath.join(datasetInfo.basePath, f))
      .join('\n');
    await fs.writeFile(manifestFile, fileData);
    command = [
      `source ${setupScriptPath} &&`,
      'kwiver runner',
      `-p "${pipelinePath}"`,
      `-s input:video_filename="${manifestFile}"`,
      `-s detector_writer:file_name="${detectorOutput}"`,
      `-s track_writer:file_name="${trackOutput}"`,
      `| tee "${joblog}"`,
    ];
  }

  const job = spawn(command.join(' '), {
    shell: '/bin/bash',
    cwd: jobWorkDir,
  });

  const jobBase: DesktopJob = {
    key: `pipeline_${job.pid}_${jobWorkDir}`,
    jobType: 'pipeline',
    pid: job.pid,
    pipelineName,
    workingDir: jobWorkDir,
    datasetIds: [datasetId],
    exitCode: job.exitCode,
    startTime: new Date(),
  };

  const processChunk = (chunk: Buffer) => chunk
    .toString('utf-8')
    .split('\n')
    .filter((a) => a);

  job.stdout.on('data', (chunk: Buffer) => {
    // eslint-disable-next-line no-console
    console.debug(chunk.toString('utf-8'));
    updater({
      ...jobBase,
      body: processChunk(chunk),
    });
  });

  job.stderr.on('data', (chunk: Buffer) => {
    // eslint-disable-next-line no-console
    console.log(chunk.toString('utf-8'));
    updater({
      ...jobBase,
      body: processChunk(chunk),
    });
  });

  job.on('exit', async (code) => {
    // eslint-disable-next-line no-console
    if (code === 0) {
      try {
        await common.postprocess([trackOutput, detectorOutput], datasetId);
      } catch (err) {
        console.error(err);
      }
    }
    updater({
      ...jobBase,
      body: [''],
      exitCode: code,
      endTime: new Date(),
    });
  });

  return jobBase;
}

/**
 * Run training on dataset list.
 * 
 * New pipeline will be created at settings.dataPath/trainedPipes
 * Training process working directory will be a regular common.createKwiverWorkingDir
 * under the first dataset in the list.
 *
 * @param runTrainingArgs training arguments
 * @param updater callback for logging and process updates
 * @returns job
 */
async function runTraining(
  runTrainingArgs: TrainPipeline,
  updater: (msg: DesktopJobUpdate) => void,
): Promise<DesktopJob> {
  const { datasetIds, settings } = runTrainingArgs;
  const newPipelineName = common.sanitizeUserInput(runTrainingArgs.newPipelineName);
  if (datasetIds.length === 0) {
    throw new Error('Must have at least 1 dataset to train on');
  }

  const isValid = await validateViamePath(settings);
  if (isValid !== true) {
    throw new Error(isValid);
  }

  const setupScriptPath = npath.join(settings.viamePath, SetupScriptName);

  // For now, just use datasetIds[0] aux folder as job working directory
  // TODO decide if this needs to change
  const datasetInfo0 = await common.getDatasetBase(datasetIds[0]);
  const auxPath0 = await common.getAuxFolder(datasetInfo0.basePath);
  const jobWorkDir0 = await common.createKwiverRunWorkingDir(
    datasetInfo0.name, auxPath0, newPipelineName,
  );

  const jobBase: DesktopJob = {
    // key: `training_${job.pid}_${jobWorkDir}`,
    key: `training_${jobWorkDir0}`,
    jobType: 'training',
    pid: 0, // TODO
    pipelineName: newPipelineName,
    workingDir: jobWorkDir0,
    datasetIds,
    exitCode: null,
    startTime: new Date(),
  };

  return jobBase;
}

export default {
  DefaultSettings,
  validateViamePath,
  runPipeline,
};
