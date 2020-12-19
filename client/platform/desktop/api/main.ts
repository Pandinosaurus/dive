import { AddressInfo } from 'net';
import path from 'path';

import { ipcRenderer, remote, FileFilter } from 'electron';
import fs from 'fs-extra';
import mime from 'mime-types';

import {
  Attribute,
  DatasetMetaMutable,
  DatasetType, FrameImage,
  Pipe,
  Pipelines, TrainingConfigs,
} from 'viame-web-common/apispec';

import common from '../backend/platforms/common';
import {
  DesktopJob, NvidiaSmiReply, RunPipeline,
  websafeImageTypes, websafeVideoTypes,
  DesktopDataset, Settings, validVideoFormats, FFProbeResults, ConvertFFMPEG,
} from '../constants';

const { loadDetections, saveDetections } = common;

function mediaServerInfo(): Promise<AddressInfo> {
  return ipcRenderer.invoke('info');
}

function nvidiaSmi(): Promise<NvidiaSmiReply> {
  return ipcRenderer.invoke('nvidia-smi');
}

function openLink(url: string): Promise<void> {
  return ipcRenderer.invoke('open-link-in-browser', url);
}


async function openFromDisk(datasetType: DatasetType) {
  let filters: FileFilter[] = [];
  if (datasetType === 'video') {
    filters = [
      { name: 'Videos', extensions: websafeVideoTypes.map((str) => str.split('/')[1]) },
    ];
  }
  const results = await remote.dialog.showOpenDialog({
    properties: [datasetType === 'video' ? 'openFile' : 'openDirectory'],
    filters,
  });
  return results;
}

async function getAttributes() {
  return Promise.resolve([] as Attribute[]);
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function setAttribute({ addNew, data }: {addNew: boolean | undefined; data: Attribute}) {
  return Promise.resolve();
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function deleteAttribute(data: Attribute) {
  return Promise.resolve([] as Attribute[]);
}

async function getPipelineList(settings: Settings): Promise<Pipelines> {
  return ipcRenderer.invoke('get-pipeline-list', settings);
}

function ffprobe(file: string): Promise<FFProbeResults> {
  return ipcRenderer.invoke('ffprobe', file);
}

async function ffmpegConvert(fileData: ConvertFFMPEG[]) {
  const job: DesktopJob = await ipcRenderer.invoke('run-ffmpeg-convert', fileData);
  return job;
}

// eslint-disable-next-line @typescript-eslint/no-unused-vars
async function getTrainingConfigurations(): Promise<TrainingConfigs> {
  return Promise.resolve({ configs: [], default: '' });
}

async function runTraining(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  folderId: string, pipelineName: string, config: string,
): Promise<unknown> {
  return Promise.resolve();
}

async function loadMetadata(datasetId: string): Promise<DesktopDataset> {
  let datasetType = undefined as 'video' | 'image-sequence' | undefined;
  let videoUrl = '';
  let videoPath = '';
  let basePath = datasetId; // default to image-sequence type basepath
  const imageData = [] as FrameImage[];
  const serverInfo = await mediaServerInfo();


  async function processFile(abspath: string): Promise<ConvertFFMPEG> {
    const basename = path.basename(abspath);
    const abspathuri = `http://localhost:${serverInfo.port}/api/media?path=${abspath}`;
    const mimetype = mime.lookup(abspath);
    if (mimetype && websafeVideoTypes.includes(mimetype)) {
      datasetType = 'video';
      basePath = path.dirname(datasetId); // parent directory of video;
      videoPath = abspath;
      videoUrl = abspathuri;
    } if (mimetype && websafeImageTypes.includes(mimetype)) {
      datasetType = 'image-sequence';
      imageData.push({
        url: abspathuri,
        filename: basename,
      });
      return { convert: false, datasetId, basePath };
    } if (validVideoFormats.includes(path.extname(abspath).replace('.', ''))) {
      //Check to see if we can convert it
      datasetType = 'video';
    }
    if (datasetType === 'video') {
      const ffprobeJSON = await ffprobe(abspath);
      if (ffprobeJSON && ffprobeJSON.streams) {
        const websafe = ffprobeJSON.streams.filter((el) => el.codec_name === 'h264' && el.codec_type === 'video');
        if (websafe.length) {
          //TODO: update the videoPath to the project location here depending on the looping
          return {
            convert: 'video',
            datasetId,
            basePath,
            source: abspath,
            dest: abspath.replace(path.extname(abspath), '_converted.mp4'),
          };
        }
      }
    }
    return { convert: false, datasetId, basePath };
  }

  const info = await fs.stat(datasetId);

  let possibleConverts: ConvertFFMPEG[] = [];
  if (info.isDirectory()) {
    const contents = await fs.readdir(datasetId);
    const fileList = [];
    for (let i = 0; i < contents.length; i += 1) {
      fileList.push(path.join(datasetId, contents[i]));
    }
    possibleConverts = await Promise.all(fileList.map(processFile));
  } else {
    const singleFile = await processFile(datasetId);
    possibleConverts.push(singleFile);
  }
  console.log(possibleConverts);
  // Now we need to see what needs to be converted and update
  // the corresponding file location and kick off the jobs
  const imageFiles = possibleConverts.filter((item) => item.convert !== false && item.convert === 'image');
  const videoFiles = possibleConverts.filter((item) => item.convert !== false && item.convert === 'video');
  //We batch the images into a single job, we handle videoFiles individually

  if (videoFiles.length) {
    videoFiles.forEach((item) => ipcRenderer.invoke('run-ffmpeg-convert', [item]));
  }
  if (imageFiles.length) {
    ipcRenderer.invoke('run-ffmpeg-conver', imageFiles);
  }


  if (datasetType === undefined) {
    throw new Error(`Cannot open dataset ${datasetId}: No images or video found`);
  }

  return Promise.resolve({
    name: path.basename(datasetId),
    basePath,
    videoPath,
    meta: {
      type: datasetType,
      fps: 10,
      imageData: datasetType === 'image-sequence' ? imageData : [],
      videoUrl: datasetType === 'video' ? videoUrl : undefined,
    },
  });
}

// eslint-disable-next-line
async function saveMetadata(datasetId: string, metadata: DatasetMetaMutable) {
  return Promise.resolve();
}

async function runPipeline(itemId: string, pipeline: Pipe, settings: Settings) {
  const args: RunPipeline = {
    pipelineName: pipeline.name,
    datasetId: itemId,
    settings,
  };
  const job: DesktopJob = await ipcRenderer.invoke('run-pipeline', args);
  return job;
}

export {
  /* Standard common APIs */
  getAttributes,
  setAttribute,
  deleteAttribute,
  getPipelineList,
  runPipeline,
  getTrainingConfigurations,
  runTraining,
  loadDetections,
  saveDetections,
  loadMetadata,
  saveMetadata,
  /* Nonstandard APIs */
  openFromDisk,
  openLink,
  nvidiaSmi,
  ffprobe,
};
