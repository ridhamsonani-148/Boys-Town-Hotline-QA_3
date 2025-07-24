import { useState } from 'react';
import './Navbar.css';
import logo from '../../assets/logo.png';

const PersonIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M10 10C12.7614 10 15 7.76142 15 5C15 2.23858 12.7614 0 10 0C7.23858 0 5 2.23858 5 5C5 7.76142 7.23858 10 10 10ZM10 12.5C6.66667 12.5 0 14.1667 0 17.5V20H20V17.5C20 14.1667 13.3333 12.5 10 12.5Z" fill="currentColor"/>
  </svg>
);

const UploadIcon = () => (
  <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
    <path d="M10 1L6 5H8V12H12V5H14L10 1ZM4 17V15H16V17C16 17.55 15.55 18 15 18H5C4.45 18 4 17.55 4 17Z" fill="currentColor"/>
  </svg>
);

function Navbar({ activeTab, setActiveTab }) {

  return (
    <div className="navbar">
      <div className="navbar-logo" style={{ backgroundImage: `url('${logo}')` }} />
      
      <div className="navbar-search">
        <div 
          className={`search-tab ${activeTab === 'upload' ? 'active' : ''}`}
          onClick={() => setActiveTab('upload')}
        >
          <UploadIcon className="tab-icon" />
          <span>Upload</span>
        </div>
        <div 
          className={`search-tab ${activeTab === 'dashboard' ? 'active' : ''}`}
          onClick={() => setActiveTab('dashboard')}
        >
          <PersonIcon className="tab-icon" />
          <span>Agents Dashboard</span>
        </div>
      </div>
      
      
    </div>
  );
}

export default Navbar;