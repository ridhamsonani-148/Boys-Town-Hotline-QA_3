import { useState, useRef, useEffect } from 'react';
import './UploadContainer.css';
import { uploadService } from '../../services/uploadService';

const imgHeadsetBase = "http://localhost:3845/assets/a66be842bec527b13441dcf2743fcf4ff6738079.svg";
const imgHeadsetMic = "http://localhost:3845/assets/3bec8d72294e72fa71bb179a6527aeceab51f3b7.svg";
const imgCloudBase = "http://localhost:3845/assets/dab477c6ade2d19b6d463e2d6994e32669d7440c.svg";
const imgCloudArrow = "http://localhost:3845/assets/1341436524ee09305f963b60ac028ee70c332cdc.svg";
const imgUpgrade = "http://localhost:3845/assets/2d0036a4673d40b1ba9724f1c380e9f17ffe6c49.svg";
const imgEllipseGreen = "http://localhost:3845/assets/6130f96df77b741cf7ae9f759e532e8e561f4d73.svg";
const imgEllipseBlue = "http://localhost:3845/assets/cafbce33aed15be6760c1d1dbba9e85aa41a71ff.svg";
const imgCheckBase = "http://localhost:3845/assets/8ab076a8dfc20f6877f2d8f0ab921a70237c613e.svg";
const imgCheckMark = "http://localhost:3845/assets/df81768c556c01ffa96a3ce442aca909caabd321.svg";
const imgRotateBase = "http://localhost:3845/assets/75979eac7f49db749d0f01011b438e1d79c0f9b5.svg";
const imgRotateArrow = "http://localhost:3845/assets/e1257f2c51549d618e77e8cacc2dd7db4336f6f2.svg";

function UploadContainer({ onUploadSuccess }) {
  const [selectedFiles, setSelectedFiles] = useState([]);
  const [isDragOver, setIsDragOver] = useState(false);
  const [isUploading, setIsUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const [fileDetails, setFileDetails] = useState([]);

  const fileInputRef = useRef(null);

  const validateFile = (file) => {
    // Get allowed file types from environment variables or use defaults
    const allowedTypesStr = process.env.REACT_APP_ALLOWED_FILE_TYPES || 'wav,mp3';
    const allowedExtensions = allowedTypesStr.split(',').map(ext => `.${ext.trim().toLowerCase()}`);
    const allowedTypes = ['audio/wav', 'audio/mpeg', 'audio/mp3'];
    
    const fileExtension = file.name.toLowerCase().substring(file.name.lastIndexOf('.'));
    
    return allowedTypes.includes(file.type) || allowedExtensions.includes(fileExtension);
  };

  const handleFileSelect = (files) => {
    const validFiles = Array.from(files).filter(validateFile);
    if (validFiles.length > 0) {
      setSelectedFiles(validFiles);
      
      // Create file details with placeholders for agent names
      const details = validFiles.map(file => ({
        id: Math.random().toString(36).substring(2, 9),
        file: file,
        name: file.name,
        agentName: '-',
        size: file.size
      }));
      
      setFileDetails(details);
    } else {
      alert('Please select supported audio files (.wav, .mp3)');
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setIsDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setIsDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setIsDragOver(false);
    handleFileSelect(e.dataTransfer.files);
  };

  const handleBrowseClick = (e) => {
    e.stopPropagation();
    fileInputRef.current.click();
  };

  const handleFileInputChange = (e) => {
    handleFileSelect(e.target.files);
  };

  const handleAreaClick = () => {
    fileInputRef.current.click();
  };

  const uploadSingleFile = async (fileDetail) => {
    try {
      const apiResult = await uploadService.uploadFile(
        fileDetail.file, 
        (progress) => {
          setUploadProgress(progress);
        },
        (status, results) => {
          //console.log(`Analysis status: ${status}`, results);
          
          // Update agent name when results are available
          if (status === 'completed' && results) {
            setFileDetails(prevDetails => 
              prevDetails.map(detail => 
                detail.id === fileDetail.id 
                  ? { ...detail, agentName: results.agentName || results.agent || '-' }
                  : detail
              )
            );
          }
        }
      );
      return { ...apiResult, fileDetailId: fileDetail.id };
    } catch (error) {
      console.error(`Upload failed for ${fileDetail.name}:`, error);
      throw error;
    }
  };

  const handleUpload = async () => {
    setIsUploading(true);
    setUploadProgress(0);
    
    try {
      // If only one file, use simple upload
      if (fileDetails.length === 1) {
        const apiResult = await uploadSingleFile(fileDetails[0]);
        setIsUploading(false);
        if (onUploadSuccess) onUploadSuccess(fileDetails[0].name);
        return;
      }
      
      // For multiple files, upload them one by one
      const results = [];
      for (let i = 0; i < fileDetails.length; i++) {
        const fileDetail = fileDetails[i];
        const result = await uploadSingleFile(fileDetail);
        results.push(result);
        // Update overall progress
        setUploadProgress(Math.round(((i + 1) / fileDetails.length) * 100));
      }
      
      setIsUploading(false);
      if (onUploadSuccess) onUploadSuccess(fileDetails.map(detail => detail.name).join(', '));
    } catch (error) {
      console.error('Upload failed:', error);
      setIsUploading(false);
      alert('Upload failed. Please try again.');
    }
  };



  return (
    <div className="upload-container">
      <div className="headset-container">
        <div className="headset-icon">
          <img src={imgHeadsetMic} alt="" className="headset-mic" />
        </div>
      </div>
      <div className="upload-header">
        <h2>Upload Call Recording</h2>
      </div>
      
      <div 
        className={`upload-area ${isDragOver ? 'drag-over' : ''} ${selectedFiles.length > 0 ? 'file-selected' : ''}`}
        onDragOver={selectedFiles.length === 0 ? handleDragOver : undefined}
        onDragLeave={selectedFiles.length === 0 ? handleDragLeave : undefined}
        onDrop={selectedFiles.length === 0 ? handleDrop : undefined}
        onClick={selectedFiles.length === 0 ? handleAreaClick : undefined}
      >
        {selectedFiles.length === 0 ? (
          <>
            <div className="upload-circle">
              <div className="cloud-icon">
                <img src={imgCloudBase} alt="" className="cloud-base" />
                <img src={imgCloudArrow} alt="" className="cloud-arrow" />
              </div>
            </div>
            <p className="upload-text">Drag and Drop or click to browse</p>
            <p className="file-types">Supported file types - .wav, .mp3</p>
            <button className="browse-btn" onClick={handleBrowseClick}>
              <img src={imgUpgrade} alt="" className="upgrade-icon" />
              <span>Browse Files</span>
            </button>
          </>
        ) : (
          <>
            <div className="selected-circle">
              <img src={isUploading ? imgEllipseBlue : imgEllipseGreen} alt="" className="circle-bg" />
              <div className="cloud-icon-selected">
                <img src={imgCloudBase} alt="" className="cloud-base" />
                <img src={imgCloudArrow} alt="" className="cloud-arrow" />
              </div>
            </div>
            <div className="file-selected-header">
              <p className="file-selected-text">{selectedFiles.length === 1 ? 'File Selected' : `${selectedFiles.length} Files Selected`}</p>
              <div className="check-done-icon">
                <img src={imgCheckBase} alt="" className="done-base" />
                <img src={imgCheckMark} alt="" className="done-mark" />
              </div>
            </div>
            <div className="file-details">
              <p className="file-name">
                <span className="file-name-text small-filename">{fileDetails.map(detail => detail.name).join(', ')}</span>
              </p>
              <p className="file-size">{(fileDetails.reduce((total, detail) => total + detail.size, 0) / (1024 * 1024)).toFixed(1)} MB</p>
            </div>
          </>
        )}
      </div>
      
      <input
        ref={fileInputRef}
        type="file"
        accept=".wav,.mp3,audio/wav,audio/mpeg"
        multiple
        onChange={handleFileInputChange}
        style={{ display: 'none' }}
      />
      

      
      <button 
        className={`upload-btn ${isUploading ? 'uploading' : ''}`}
        disabled={fileDetails.length === 0 || isUploading}
        onClick={handleUpload}
      >
        {isUploading && (
          <div className="rotate-icon">
            <img src={imgRotateBase} alt="" className="rotate-base" />
            <img src={imgRotateArrow} alt="" className="rotate-arrow" />
          </div>
        )}
        Upload Recording
      </button>
      
      {isUploading && (
        <div className="progress-container">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${uploadProgress}%` }}></div>
          </div>
          <div className="progress-percentage">{uploadProgress} %</div>
        </div>
      )}
    </div>
  );
}

export default UploadContainer;