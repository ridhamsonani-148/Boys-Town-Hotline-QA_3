import { useState, useRef, useEffect } from 'react';
import './UploadContainer.css';
import { uploadService } from '../../services/uploadService';

const HeadsetIcon = () => (
  <svg width="40" height="40" viewBox="0 0 60 60" fill="none">
    <path d="M30 5C20.335 5 12.5 12.835 12.5 22.5V30H17.5V22.5C17.5 15.596 23.096 10 30 10C36.904 10 42.5 15.596 42.5 22.5V30H47.5V22.5C47.5 12.835 39.665 5 30 5ZM7.5 32.5C5.845 32.5 4.5 33.845 4.5 35.5V45C4.5 46.655 5.845 48 7.5 48H15V32.5H7.5ZM45 32.5V48H52.5C54.155 48 55.5 46.655 55.5 45V35.5C55.5 33.845 54.155 32.5 52.5 32.5H45Z" fill="#094677"/>
  </svg>
);

const CloudIcon = () => (
  <svg width="30" height="30" viewBox="0 0 40 30" fill="none">
    <path d="M32 15C31.45 9.5 26.85 5 21 5C16.5 5 12.65 7.6 10.9 11.4C4.9 12.1 0 17.2 0 23.5C0 30.1 5.4 35.5 12 35.5H31C36.5 35.5 41 31 41 25.5C41 20.2 37 15.8 32 15Z" fill="#666"/>
    <path d="M20 18L16 22H18V28H22V22H24L20 18Z" fill="white"/>
  </svg>
);

const UpgradeIcon = () => (
  <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
    <path d="M8 1L4 5H6V10H10V5H12L8 1ZM2 13V11H14V13H2Z" fill="currentColor"/>
  </svg>
);

const EllipseGreen = () => (
  <svg width="20" height="20" viewBox="0 0 120 120" fill="none">
    <circle cx="60" cy="60" r="60" fill="#4CAF50"/>
  </svg>
);

const EllipseBlue = () => (
  <svg width="20" height="20" viewBox="0 0 120 120" fill="none">
    <circle cx="60" cy="60" r="60" fill="#2196F3"/>
  </svg>
);

const CheckIcon = () => (
  <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
    <circle cx="12" cy="12" r="12" fill="#4CAF50"/>
    <path d="M9 12L11 14L15 10" stroke="white" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

const RotateIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none" className="spinning">
    <path d="M4 4V9H9M16 16V11H11M4 9C4 13.4183 7.58172 17 12 17C14.5 17 16.7 15.8 18 14M16 11C16 6.58172 12.4183 3 8 3C5.5 3 3.3 4.2 2 6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
  </svg>
);

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
              <div className="cloud-icon">
                <CloudIcon className="cloud-base" />
              </div>
            <p className="upload-text">Drag and Drop or click to browse</p>
            <p className="file-types">Supported file types - .wav, .mp3</p>
            <button className="browse-btn" onClick={handleBrowseClick}>
              <UpgradeIcon className="upgrade-icon" />
              <span>Browse Files</span>
            </button>
          </>
        ) : (
          <>
              {isUploading ? <EllipseBlue className="circle-bg" /> : <EllipseGreen className="circle-bg" />}
              <div className="cloud-icon-selected">
                <CloudIcon className="cloud-base" />
              </div>
            <div className="file-selected-header">
              <p className="file-selected-text">{selectedFiles.length === 1 ? 'File Selected' : `${selectedFiles.length} Files Selected`}</p>
              <div className="check-done-icon">
                <CheckIcon className="done-base" />
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
            <RotateIcon className="rotate-base" />
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